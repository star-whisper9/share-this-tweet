import { VideoPlanError, type ProbedVideoInput, type VideoRenderPlan } from './video-plan.js';

/** Fixed quality preset; processing guards are configured separately. */
export function createGifRenderPlan(probe: ProbedVideoInput): VideoRenderPlan {
  if (
    ![probe.width, probe.height, probe.duration].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new VideoPlanError('invalidProbe');
  const scale = Math.min(1, 960 / Math.max(probe.width, probe.height));
  const width = Math.max(1, Math.round(probe.width * scale));
  const height = Math.max(1, Math.round(probe.height * scale));
  const frameRate = Math.min(20, probe.frameRate ?? 20);
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new VideoPlanError('invalidProbe');
  return {
    width,
    height,
    duration: probe.duration,
    frameRate,
    gap: 0,
    tiles: [{ width, height, x: 0 }],
  };
}

export function createGifFfmpegArgs(
  path: string,
  plan: VideoRenderPlan,
): { palette: string[]; encode: string[] } {
  const transform = `fps=${plan.frameRate},scale=${plan.width}:${plan.height}:flags=lanczos,setsar=1`;
  const common = [
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
    '-i',
    path,
  ];
  // Two passes avoid buffering every decoded frame while waiting for the global palette.
  return {
    palette: [
      ...common,
      '-vf',
      `${transform},palettegen=max_colors=256:stats_mode=full`,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      'palette.png',
    ],
    encode: [
      ...common,
      '-i',
      'palette.png',
      '-filter_complex',
      `[0:v:0]${transform}[v];[v][1:v:0]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]`,
      '-map',
      '[out]',
      '-an',
      '-loop',
      '0',
      'output.gif',
    ],
  };
}
