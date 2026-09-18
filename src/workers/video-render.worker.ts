import type { FFmpegCoreModule, FFmpegCoreModuleFactory, Log } from '@ffmpeg/types';
import { executeVideoJob, type VideoCoreAdapter } from '../core/video-engine.js';
import {
  VideoDiagnosticReporter,
  type VideoDiagnosticMemorySample,
} from '../core/video-diagnostics.js';
import { MAX_VIDEO_INPUTS, VideoPlanError } from '../core/video-plan.js';
import { t, type MessageKey } from '../shared/i18n.js';
import { VideoLimitError } from '../shared/video-experiment.js';
import type {
  VideoRenderFrame,
  VideoRenderInboundMessage,
  VideoRenderRequest,
  VideoRenderWorkerMessage,
} from '../shared/video-render.js';

type RawFfprobeCore = FFmpegCoreModule & {
  _ffprobe?: (argc: number, argv: number) => number;
  stringsToPtr?: (args: string[]) => number;
  HEAPU8?: Uint8Array;
};
type RawFs = RawFfprobeCore['FS'] & {
  lookupPath?: (path: string, options?: { follow?: boolean }) => { node?: { contents?: unknown } };
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
let diagnostics: VideoDiagnosticReporter | undefined;

function post(message: VideoRenderWorkerMessage): void {
  scope.postMessage(message);
}

function appendLog(log: Log): void {
  const line = `${log.type}: ${log.message}`.trim();
  if (!line) return;
  recentLogs.push(line);
  if (recentLogs.length > 20) recentLogs = recentLogs.slice(-20);
  diagnostics?.noteFfmpegLog(line);
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

function withMachineProgress(args: string[]): string[] {
  const output = args.at(-1);
  if (!output) throw new Error('FFmpeg output path missing');
  return [
    ...args.slice(0, -1),
    '-loglevel',
    'info',
    '-progress',
    'pipe:1',
    '-stats_period',
    '2',
    '-nostats',
    output,
  ];
}

function fileSize(core: RawFfprobeCore, path: string): number | undefined {
  try {
    const size = core.FS.stat(path).size;
    return Number.isFinite(size) && size >= 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

function outputBufferCapacity(core: RawFfprobeCore, path: string): number | undefined {
  try {
    const node = (core.FS as RawFs).lookupPath?.(path, { follow: true }).node;
    const contents = node?.contents;
    if (
      contents &&
      typeof contents === 'object' &&
      'byteLength' in contents &&
      typeof (contents as { byteLength?: unknown }).byteLength === 'number'
    ) {
      const bytes = (contents as { byteLength: number }).byteLength;
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readMemorySample(core: RawFfprobeCore, inputCount: number): VideoDiagnosticMemorySample {
  // Input extensions differ by media type, so find the known names without reading their bytes.
  const paths = Array.from({ length: inputCount }, (_, index) => [
    `input-${index}.image`,
    `input-${index}.gif.mp4`,
    `input-${index}.video.mp4`,
  ]).flat();
  let foundInput = false;
  const totalInputFileBytes = paths.reduce((total, path) => {
    const bytes = fileSize(core, path);
    if (bytes !== undefined) foundInput = true;
    return total + (bytes ?? 0);
  }, 0);
  const outputFileBytes = fileSize(core, 'output.mp4');
  const outputCapacity = outputBufferCapacity(core, 'output.mp4');
  const result: VideoDiagnosticMemorySample = {
    ...(core.HEAPU8?.buffer.byteLength !== undefined
      ? { wasmCapacityBytes: core.HEAPU8.buffer.byteLength }
      : {}),
    ...(foundInput ? { inputFileBytes: totalInputFileBytes } : {}),
    ...(outputFileBytes !== undefined ? { outputFileBytes } : {}),
    ...(outputCapacity !== undefined ? { outputBufferCapacityBytes: outputCapacity } : {}),
  };
  return result;
}

function createAdapter(
  core: RawFfprobeCore,
  onEncodingProgress: (progress: number, time: number) => void,
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
    diagnosticArgs: withMachineProgress,
    exec: (args) => {
      recentLogs = [];
      core.reset();
      core.setProgress(({ progress, time }) => onEncodingProgress(progress, time));
      return core.exec(...withMachineProgress(args));
    },
    ffprobe: (args) => {
      recentLogs = [];
      core.reset();
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
  if (error instanceof VideoLimitError) return error.message;
  let code: MessageKey = 'video.error.ffmpegFailed';
  const params: Record<string, string | number> = {};
  if (error instanceof VideoPlanError) {
    code = `video.error.${error.code}` as MessageKey;
  }
  if (code === 'video.error.maxInputs') params.count = MAX_VIDEO_INPUTS;
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
  let diagnosticCore: RawFfprobeCore | undefined;
  const reporter = new VideoDiagnosticReporter({
    emit: (sample) => post({ type: 'diagnostics', id: request.id, sample }),
    readMemory: () =>
      diagnosticCore ? readMemorySample(diagnosticCore, request.inputs.length) : {},
  });
  diagnostics = reporter;
  try {
    reporter.setPhase('loading');
    post({ type: 'progress', id: request.id, phase: 'loading' });
    const core = await getCore();
    coreLoaded = true;
    diagnosticCore = core;
    reporter.update({ wasmCapacityBytes: core.HEAPU8?.buffer.byteLength });
    reporter.sample(true);
    const result = await executeVideoJob(
      createAdapter(core, (progress, time) => {
        // This library callback is only a reference ratio. Machine `-progress`
        // blocks below provide the time paired with frame and speed metrics.
        void time;
        reporter.update({ rawProgress: progress });
        post({ type: 'progress', id: request.id, phase: 'encoding', progress });
      }),
      request,
      {
        onProgress: (phase) => {
          reporter.setPhase(phase);
          post({ type: 'progress', id: request.id, phase });
        },
        onDiagnosticStage: (phase) => reporter.setPhase(phase),
        onDiagnosticMetadata: (metadata) =>
          post({ type: 'diagnostics', id: request.id, sample: reporter.snapshot(), metadata }),
        onDiagnosticOutputCopyBytes: (bytes) => reporter.update({ outputCopyBytes: bytes }),
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
    reporter.setPhase('done');
    post({ type: 'done', id: request.id, ...result });
  } catch (error) {
    reporter.setPhase('error');
    post({
      type: 'error',
      id: request.id,
      error: coreLoaded
        ? errorFor(error, request)
        : `${t('video.error.loadFailed', {}, request.locale)} ${error instanceof Error ? error.message : String(error)}`,
      ...(error instanceof VideoLimitError ? { limitExceeded: true } : {}),
    });
  } finally {
    diagnostics = undefined;
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
