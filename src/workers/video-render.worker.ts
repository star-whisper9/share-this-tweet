import type { FFmpegCoreModule, FFmpegCoreModuleFactory, Log } from '@ffmpeg/types';
import { executeVideoJob, type VideoCoreAdapter } from '../core/video-engine.js';
import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_INPUTS,
  MAX_VIDEO_INPUT_BYTES,
  VideoPlanError,
} from '../core/video-plan.js';
import { t, type MessageKey } from '../shared/i18n.js';
import type {
  VideoRenderFrame,
  VideoRenderInboundMessage,
  VideoRenderRequest,
  VideoRenderWorkerMessage,
} from '../shared/video-render.js';

type RawFfprobeCore = FFmpegCoreModule & {
  _ffprobe?: (argc: number, argv: number) => number;
  stringsToPtr?: (args: string[]) => number;
};
type CoreWorkerGlobal = {
  location: Location;
  importScripts(...urls: string[]): void;
  postMessage(message: VideoRenderWorkerMessage): void;
  onmessage: ((event: MessageEvent<VideoRenderInboundMessage>) => void) | null;
  createFFmpegCore?: FFmpegCoreModuleFactory;
};

const scope = self as unknown as CoreWorkerGlobal;
let corePromise: Promise<RawFfprobeCore> | undefined;
let active:
  | {
      id: string;
      resolveFrame: (frame: VideoRenderFrame) => void;
    }
  | undefined;
let recentLogs: string[] = [];

function post(message: VideoRenderWorkerMessage): void {
  scope.postMessage(message);
}

function appendLog(log: Log): void {
  const line = `${log.type}: ${log.message}`.trim();
  if (!line) return;
  recentLogs.push(line);
  if (recentLogs.length > 20) recentLogs = recentLogs.slice(-20);
}

function fsExists(core: RawFfprobeCore, path: string): boolean {
  try {
    core.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function getCore(): Promise<RawFfprobeCore> {
  if (!corePromise) {
    corePromise = (async () => {
      // This is deliberately a classic worker: Firefox extension CSP permits the
      // packaged UMD runtime without allowing remote scripts.
      const coreURL = new URL('../vendor/ffmpeg/ffmpeg-core.js', scope.location.href).href;
      const wasmURL = new URL('../vendor/ffmpeg/ffmpeg-core.wasm', scope.location.href).href;
      scope.importScripts(coreURL);
      if (typeof scope.createFFmpegCore !== 'function') throw new Error('missing createFFmpegCore');
      const core = (await scope.createFFmpegCore({
        // UMD replaces a caller-provided locateFile callback while initializing.
        // This is the supported URL handoff used by ffmpeg.wasm's wrapper.
        mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}`,
      })) as RawFfprobeCore;
      core.setLogger(appendLog);
      return core;
    })();
  }
  return corePromise;
}

function createAdapter(
  core: RawFfprobeCore,
  onEncodingProgress: (progress: number) => void,
): VideoCoreAdapter {
  return {
    writeFile: (path, bytes) => core.FS.writeFile(path, bytes),
    readFile: (path) => {
      const value = core.FS.readFile(path, { encoding: 'binary' });
      if (!(value instanceof Uint8Array))
        throw new Error('FFmpeg FS returned text for a binary file');
      return value;
    },
    exists: (path) => fsExists(core, path),
    unlink: (path) => core.FS.unlink(path),
    exec: (args) => {
      recentLogs = [];
      core.reset();
      core.setTimeout(120_000);
      core.setProgress(({ progress }) => onEncodingProgress(Math.max(0, Math.min(1, progress))));
      return core.exec(...args);
    },
    ffprobe: (args) => {
      recentLogs = [];
      core.reset();
      core.setTimeout(15_000);
      // ffmpeg.wasm 0.12's public ffprobe wrapper can leave `ret` at -1 even
      // after success. The packaged UMD core exposes this C entry point and its
      // argument allocator, so use the actual C return code instead.
      if (!core._ffprobe || !core.stringsToPtr) throw new Error('ffprobe API unavailable');
      const outputPath = 'probe.json';
      if (fsExists(core, outputPath)) core.FS.unlink(outputPath);
      const inputPath = args.at(-1);
      if (!inputPath) throw new Error('ffprobe input missing');
      const fullArgs = ['./ffprobe', ...args.slice(0, -1), '-o', outputPath, inputPath];
      const exitCode = core._ffprobe(fullArgs.length, core.stringsToPtr(fullArgs));
      try {
        if (!fsExists(core, outputPath)) return { exitCode: exitCode || 1, output: '' };
        const value = core.FS.readFile(outputPath, { encoding: 'binary' });
        if (!(value instanceof Uint8Array)) throw new Error('ffprobe returned text output');
        return { exitCode, output: new TextDecoder().decode(value) };
      } finally {
        if (fsExists(core, outputPath)) core.FS.unlink(outputPath);
      }
    },
  };
}

function isRequest(value: unknown): value is VideoRenderRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<VideoRenderRequest>;
  return (
    request.type === 'start' &&
    typeof request.id === 'string' &&
    Array.isArray(request.inputs) &&
    (request.style === 'seamless' || request.style === 'gallery') &&
    (request.frame === 'original' || request.frame === 'top' || request.frame === 'bottom') &&
    (request.locale === 'zh-CN' || request.locale === 'en') &&
    typeof request.background === 'string' &&
    /^#[0-9a-f]{6}$/i.test(request.background) &&
    request.inputs.every(
      (input) =>
        input &&
        input.blob instanceof Blob &&
        (input.type === 'photo' || input.type === 'video' || input.type === 'animated_gif'),
    )
  );
}

function errorFor(error: unknown, request: VideoRenderRequest): string {
  let code: MessageKey = 'video.error.ffmpegFailed';
  const params: Record<string, string | number> = {};
  if (error instanceof VideoPlanError) {
    code = `video.error.${error.code}` as MessageKey;
  }
  if (code === 'video.error.maxInputs') params.count = MAX_VIDEO_INPUTS;
  if (code === 'video.error.inputTooLarge') params.size = MAX_VIDEO_INPUT_BYTES / 1024 / 1024;
  if (code === 'video.error.durationTooLong') params.seconds = MAX_VIDEO_DURATION_SECONDS;
  const cause = error instanceof Error && !(error instanceof VideoPlanError) ? error.message : '';
  const details = [cause, ...recentLogs.slice(-20)].filter(Boolean).join('\n');
  return details
    ? `${t(code, params, request.locale)}\n${details}`
    : t(code, params, request.locale);
}

async function start(request: VideoRenderRequest): Promise<void> {
  if (active) {
    post({ type: 'error', id: request.id, error: t('video.error.busy', {}, request.locale) });
    return;
  }
  let resolveFrame: ((frame: VideoRenderFrame) => void) | undefined;
  const frameReply = new Promise<VideoRenderFrame>((resolve) => {
    resolveFrame = resolve;
  });
  active = { id: request.id, resolveFrame: resolveFrame! };
  let coreLoaded = false;
  try {
    post({ type: 'progress', id: request.id, phase: 'loading' });
    const core = await getCore();
    coreLoaded = true;
    const result = await executeVideoJob(
      createAdapter(core, (progress) => {
        post({ type: 'progress', id: request.id, phase: 'encoding', progress });
      }),
      request,
      {
        onProgress: (phase) => post({ type: 'progress', id: request.id, phase }),
        onLayout: async (layout) => {
          post({
            type: 'layout',
            id: request.id,
            width: layout.width,
            height: layout.height,
            duration: layout.duration,
          });
          return frameReply;
        },
      },
    );
    post({ type: 'done', id: request.id, ...result });
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      error: coreLoaded
        ? errorFor(error, request)
        : `${t('video.error.loadFailed', {}, request.locale)} ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    active = undefined;
  }
}

scope.onmessage = (event: MessageEvent<VideoRenderInboundMessage>) => {
  const message = event.data;
  if (message?.type === 'frame') {
    if (!active || active.id !== message.id) return;
    active.resolveFrame(message);
    return;
  }
  if (!isRequest(message)) return;
  void start(message);
};
