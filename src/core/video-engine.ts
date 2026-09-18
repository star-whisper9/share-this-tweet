import {
  MAX_VIDEO_INPUT_BYTES,
  MAX_VIDEO_INPUTS,
  VideoPlanError,
  createVideoFfmpegArgs,
  createVideoRenderPlan,
  type ProbedVideoInput,
  type VideoRenderPlan,
} from './video-plan.js';
import type {
  VideoRenderFrame,
  VideoRenderInput,
  VideoRenderRequest,
} from '../shared/video-render.js';

export interface VideoCoreAdapter {
  writeFile(path: string, bytes: Uint8Array): void;
  readFile(path: string): Uint8Array;
  exists(path: string): boolean;
  unlink(path: string): void;
  exec(args: string[]): number;
  /** Runs ffprobe and returns only its machine-readable stdout. */
  ffprobe(args: string[]): { exitCode: number; output: string };
}

export interface VideoJobResult {
  blob: Blob;
  width: number;
  height: number;
  duration: number;
}

export interface VideoJobCallbacks {
  onLayout(layout: VideoRenderPlan): Promise<VideoRenderFrame>;
  onProgress(phase: 'probing' | 'encoding'): void;
}

interface ProbeJson {
  streams?: Array<{
    codec_type?: string;
    width?: number | string;
    height?: number | string;
    duration?: number | string;
    sample_aspect_ratio?: string;
    side_data_list?: Array<{ rotation?: number | string }>;
  }>;
  format?: { duration?: number | string };
}

function toFiniteNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === 'N/A') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseVideoProbe(output: string): ProbedVideoInput {
  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(output) as ProbeJson;
  } catch {
    throw new VideoPlanError('invalidProbe');
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const width = toFiniteNumber(video?.width);
  const height = toFiniteNumber(video?.height);
  const duration = toFiniteNumber(video?.duration) ?? toFiniteNumber(parsed.format?.duration) ?? 0;
  if (!width || !height || duration < 0) throw new VideoPlanError('invalidProbe');
  if (
    (video?.sample_aspect_ratio &&
      video.sample_aspect_ratio !== '1:1' &&
      video.sample_aspect_ratio !== 'N/A') ||
    video?.side_data_list?.some((data) => (toFiniteNumber(data.rotation) ?? 0) !== 0)
  )
    throw new VideoPlanError('unsupportedGeometry');
  return {
    width,
    height,
    duration,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
  };
}

function extensionFor(input: VideoRenderInput): string {
  if (input.type === 'photo') return 'image';
  if (input.type === 'animated_gif') return 'gif.mp4';
  return 'video.mp4';
}

function probeArgs(path: string): string[] {
  return [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,duration,sample_aspect_ratio:stream_side_data=rotation:format=duration',
    '-of',
    'json',
    path,
  ];
}

function probe(core: VideoCoreAdapter, path: string): ProbedVideoInput {
  const result = core.ffprobe(probeArgs(path));
  if (result.exitCode !== 0) throw new VideoPlanError('invalidProbe');
  return parseVideoProbe(result.output);
}

function release(core: VideoCoreAdapter, path: string): void {
  if (core.exists(path)) core.unlink(path);
}

function assertFrame(frame: VideoRenderFrame): void {
  if (
    !frame.blob ||
    frame.blob.type !== 'image/png' ||
    !frame.height ||
    !Number.isInteger(frame.height) ||
    frame.height <= 0
  )
    throw new VideoPlanError('frameRequired');
  if (frame.height % 2) throw new VideoPlanError('invalidFrame');
}

/**
 * Executes a complete bounded FFmpeg job. The worker owns converting worker
 * messages to callbacks; this function stays browser-worker independent for
 * unit and real-WASM testing.
 */
export async function executeVideoJob(
  core: VideoCoreAdapter,
  request: VideoRenderRequest,
  callbacks: VideoJobCallbacks,
): Promise<VideoJobResult> {
  if (!request.inputs.length) throw new VideoPlanError('invalidRequest');
  if (request.inputs.length > MAX_VIDEO_INPUTS) throw new VideoPlanError('maxInputs');
  if (!request.inputs.some((input) => input.type !== 'photo'))
    throw new VideoPlanError('atLeastOneDynamic');
  const totalBytes = request.inputs.reduce((total, input) => total + input.blob.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_VIDEO_INPUT_BYTES)
    throw new VideoPlanError('inputTooLarge');

  const paths: string[] = [];
  const framePath = 'frame.png';
  let frameWritten = false;
  try {
    callbacks.onProgress('probing');
    for (const [index, input] of request.inputs.entries()) {
      const path = `input-${index}.${extensionFor(input)}`;
      core.writeFile(path, new Uint8Array(await input.blob.arrayBuffer()));
      paths.push(path);
    }
    const probes = paths.map((path) => probe(core, path));
    const plan = createVideoRenderPlan(
      request.inputs.map((input, index) => ({ type: input.type, probe: probes[index]! })),
      request.style,
    );
    const frame = await callbacks.onLayout(plan);
    let outputHeight = plan.height;
    if (request.frame !== 'original') {
      assertFrame(frame);
      core.writeFile(framePath, new Uint8Array(await frame.blob!.arrayBuffer()));
      frameWritten = true;
      const frameProbe = probe(core, framePath);
      if (frameProbe.width !== plan.width || frameProbe.height !== frame.height)
        throw new VideoPlanError('invalidFrame');
      outputHeight += frameProbe.height;
    }
    callbacks.onProgress('encoding');
    const exitCode = core.exec(
      createVideoFfmpegArgs(
        request.inputs.map((input, index) => ({ path: paths[index]!, type: input.type })),
        plan,
        request.style,
        request.background,
        request.frame,
        framePath,
      ),
    );
    if (exitCode !== 0) throw new VideoPlanError('ffmpegFailed');
    const bytes = core.readFile('output.mp4');
    if (!bytes.byteLength) throw new VideoPlanError('emptyOutput');
    const output = new Uint8Array(bytes.byteLength);
    output.set(bytes);
    return {
      blob: new Blob([output], { type: 'video/mp4' }),
      width: plan.width,
      height: outputHeight,
      duration: plan.duration,
    };
  } finally {
    for (const path of paths) release(core, path);
    if (frameWritten) release(core, framePath);
    release(core, 'output.mp4');
  }
}
