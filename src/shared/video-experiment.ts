import { t, type Locale } from './i18n.js';

/** Zero disables an individual guard; exceeded guards request an explicit fallback. */
export interface VideoLimits {
  maxInputMiB: number;
  maxDurationSeconds: number;
  maxOutputPixels: number;
  maxFrameRate: number;
}
export const VIDEO_LIMIT_PRESETS = [
  {
    id: 'cautious',
    limits: { maxInputMiB: 64, maxDurationSeconds: 30, maxOutputPixels: 2073600, maxFrameRate: 30 },
  },
  {
    id: 'standard',
    limits: {
      maxInputMiB: 256,
      maxDurationSeconds: 180,
      maxOutputPixels: 4147200,
      maxFrameRate: 30,
    },
  },
  {
    id: 'hd',
    limits: {
      maxInputMiB: 512,
      maxDurationSeconds: 600,
      maxOutputPixels: 8294400,
      maxFrameRate: 60,
    },
  },
  {
    id: 'unlimited',
    limits: { maxInputMiB: 0, maxDurationSeconds: 0, maxOutputPixels: 0, maxFrameRate: 0 },
  },
] as const;
export const DEFAULT_VIDEO_LIMITS: VideoLimits = { ...VIDEO_LIMIT_PRESETS[1].limits };
const keys = ['maxInputMiB', 'maxDurationSeconds', 'maxOutputPixels', 'maxFrameRate'] as const;
export function isVideoLimits(value: unknown): value is VideoLimits {
  if (!value || typeof value !== 'object') return false;
  return keys.every((key) => {
    const n = (value as Record<string, unknown>)[key];
    return (
      typeof n === 'number' &&
      Number.isFinite(n) &&
      n >= 0 &&
      n <= Number.MAX_SAFE_INTEGER &&
      (key !== 'maxOutputPixels' || Number.isInteger(n))
    );
  });
}
export function normalizeVideoLimits(value: unknown): VideoLimits {
  return isVideoLimits(value) ? { ...value } : { ...DEFAULT_VIDEO_LIMITS };
}
export class VideoLimitError extends Error {
  readonly code = 'video-limit';
  constructor(message: string) {
    super(message);
    this.name = 'VideoLimitError';
  }
}
export function assertVideoLimits(
  limits: VideoLimits,
  actual: {
    inputBytes?: number;
    durationSeconds?: number;
    outputPixels?: number;
    frameRate?: number;
  },
  locale?: Locale,
): void {
  if (!isVideoLimits(limits)) throw new Error(t('experiment.invalidLimits', {}, locale));
  const checks = [
    [actual.inputBytes, limits.maxInputMiB * 1048576, 'experiment.limitInput', limits.maxInputMiB],
    [
      actual.durationSeconds,
      limits.maxDurationSeconds,
      'experiment.limitDuration',
      limits.maxDurationSeconds,
    ],
    [actual.outputPixels, limits.maxOutputPixels, 'experiment.limitPixels', limits.maxOutputPixels],
    [actual.frameRate, limits.maxFrameRate, 'experiment.limitFrameRate', limits.maxFrameRate],
  ] as const;
  for (const [value, ceiling, message, limit] of checks) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error(t('experiment.invalidLimits', {}, locale));
    if (value !== undefined && ceiling > 0 && value > ceiling)
      throw new VideoLimitError(t(message, { limit }, locale));
  }
}
