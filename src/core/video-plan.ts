import type { VideoFrame, VideoMediaType, VideoStitchStyle } from '../shared/video-render.js';

export const MAX_VIDEO_INPUTS = 4;
export const DEFAULT_VIDEO_FRAME_RATE = 24;

export type VideoPlanErrorCode =
  | 'invalidRequest'
  | 'atLeastOneDynamic'
  | 'maxInputs'
  | 'inputTooLarge'
  | 'invalidProbe'
  | 'unsupportedGeometry'
  | 'sourceTooLarge'
  | 'durationTooLong'
  | 'frameRequired'
  | 'invalidFrame'
  | 'ffmpegFailed'
  | 'emptyOutput';

export class VideoPlanError extends Error {
  constructor(
    public readonly code: VideoPlanErrorCode,
    public readonly index?: number,
  ) {
    super(code);
    this.name = 'VideoPlanError';
  }
}

export interface ProbedVideoInput {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  frameRate?: number;
}

export interface VideoPlanInput {
  type: VideoMediaType;
  probe: ProbedVideoInput;
}

export interface VideoTile {
  width: number;
  height: number;
  x: number;
}

export interface VideoRenderPlan {
  width: number;
  height: number;
  duration: number;
  gap: number;
  frameRate: number;
  tiles: VideoTile[];
  audioInput?: number;
}

function evenAtLeastTwo(value: number): number {
  const rounded = Math.floor(value / 2) * 2;
  return Math.max(2, rounded);
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateProbe(probe: ProbedVideoInput, index: number): void {
  if (
    !finitePositive(probe.width) ||
    !finitePositive(probe.height) ||
    !Number.isFinite(probe.duration)
  )
    throw new VideoPlanError('invalidProbe', index);
}

/**
 * Creates an equal-height, horizontal layout without cropping or upscaling.  The
 * output follows source dimensions; no experimental size cap is applied.
 */
export function createVideoRenderPlan(
  inputs: VideoPlanInput[],
  style: VideoStitchStyle,
): VideoRenderPlan {
  if (!inputs.length) throw new VideoPlanError('invalidRequest');
  if (inputs.length > MAX_VIDEO_INPUTS) throw new VideoPlanError('maxInputs');
  inputs.forEach(({ probe }, index) => validateProbe(probe, index + 1));

  const dynamic = inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => input.type !== 'photo');
  if (!dynamic.length) throw new VideoPlanError('atLeastOneDynamic');
  if (dynamic.some(({ input }) => !finitePositive(input.probe.duration)))
    throw new VideoPlanError('invalidProbe');

  const duration = Math.max(...dynamic.map(({ input }) => input.probe.duration));
  const naturalHeight = Math.min(...inputs.map(({ probe }) => probe.height));
  const height = evenAtLeastTwo(naturalHeight);
  const gap = style === 'gallery' ? evenAtLeastTwo(Math.round(height * 0.012)) : 0;
  const widths = inputs.map(({ probe }) => evenAtLeastTwo((probe.width / probe.height) * height));
  const width = widths.reduce((sum, tileWidth) => sum + tileWidth, 0) + gap * (inputs.length - 1);
  const rates = dynamic
    .map(({ input }) => input.probe.frameRate)
    .filter((rate): rate is number => typeof rate === 'number' && finitePositive(rate));
  const frameRate = rates.length ? Math.max(...rates) : DEFAULT_VIDEO_FRAME_RATE;

  let x = 0;
  const tiles = widths.map((tileWidth) => {
    const tile = { x, width: tileWidth, height };
    x += tileWidth + gap;
    return tile;
  });
  const audioInput = inputs.findIndex(({ type, probe }) => type === 'video' && probe.hasAudio);
  return {
    width,
    height,
    duration,
    gap,
    frameRate,
    tiles,
    audioInput: audioInput < 0 ? undefined : audioInput,
  };
}

export interface VideoCommandInput {
  path: string;
  type: VideoMediaType;
}

function durationArg(duration: number): string {
  return duration.toFixed(3);
}

/** Generate the deterministic single-threaded ffmpeg invocation for a plan. */
export function createVideoFfmpegArgs(
  inputs: VideoCommandInput[],
  plan: VideoRenderPlan,
  style: VideoStitchStyle,
  background: string,
  frame: VideoFrame,
  framePath = 'frame.png',
): string[] {
  const duration = durationArg(plan.duration);
  const args = ['-threads', '1', '-filter_threads', '1'];
  for (const input of inputs) {
    if (input.type === 'photo')
      args.push(
        '-loop',
        '1',
        '-framerate',
        String(plan.frameRate),
        '-t',
        duration,
        '-i',
        input.path,
      );
    else args.push('-i', input.path);
  }
  if (frame !== 'original') args.push('-i', framePath);

  const parts = inputs.map((input, index) => {
    const tile = plan.tiles[index]!;
    const sourceDuration = input.type === 'photo' ? '' : `,trim=duration=${duration}`;
    return `[${index}:v]setpts=PTS-STARTPTS,fps=${plan.frameRate},scale=${tile.width}:${tile.height}:flags=lanczos,setsar=1${sourceDuration},tpad=stop_mode=clone:stop_duration=${duration}[v${index}]`;
  });
  let videoLabel = '[v0]';
  if (inputs.length > 1) {
    const positions = plan.tiles.map((tile) => `${tile.x}_0`).join('|');
    parts.push(
      `${inputs.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${inputs.length}:layout=${positions}:fill=${style === 'gallery' ? background : '#000000'}[strip]`,
    );
    videoLabel = '[strip]';
  }
  if (frame !== 'original') {
    const frameIndex = inputs.length;
    if (frame === 'top') parts.push(`[${frameIndex}:v]${videoLabel}vstack=inputs=2[video]`);
    else parts.push(`${videoLabel}[${frameIndex}:v]vstack=inputs=2[video]`);
    videoLabel = '[video]';
  }
  if (plan.audioInput !== undefined)
    parts.push(`[${plan.audioInput}:a]apad=pad_dur=${duration},atrim=duration=${duration}[audio]`);

  args.push('-filter_complex', parts.join(';'), '-map', videoLabel);
  if (plan.audioInput === undefined) args.push('-an');
  else args.push('-map', '[audio]', '-c:a', 'aac', '-b:a', '128k');
  args.push(
    '-t',
    duration,
    '-r',
    String(plan.frameRate),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    'output.mp4',
  );
  return args;
}
