import { t, type Locale } from './i18n.js';
import { VideoLimitError } from './video-experiment.js';

/** Zero disables an individual guard. GIF limits apply to the source MP4. */
export interface GifLimits {
  maxInputMiB: number;
  maxDurationSeconds: number;
  maxSourcePixels: number;
}
export const DEFAULT_GIF_LIMITS: GifLimits = {
  maxInputMiB: 64,
  maxDurationSeconds: 60,
  maxSourcePixels: 8294400,
};
const keys = ['maxInputMiB', 'maxDurationSeconds', 'maxSourcePixels'] as const;
export function isGifLimits(value: unknown): value is GifLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return keys.every((key) => {
    const n = (value as Record<string, unknown>)[key];
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  });
}
export function normalizeGifLimits(value: unknown): GifLimits {
  if (value === undefined) return { ...DEFAULT_GIF_LIMITS };
  if (!isGifLimits(value)) throw new Error(t('gif.invalidLimits'));
  return { ...value };
}
export class GifLimitError extends VideoLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'GifLimitError';
  }
}
export function assertGifLimits(
  limits: GifLimits,
  actual: { inputBytes?: number; durationSeconds?: number; sourcePixels?: number },
  locale?: Locale,
): void {
  if (!isGifLimits(limits)) throw new Error(t('gif.invalidLimits', {}, locale));
  const checks = [
    [actual.inputBytes, limits.maxInputMiB * 1048576, 'gif.limitInput', limits.maxInputMiB],
    [
      actual.durationSeconds,
      limits.maxDurationSeconds,
      'gif.limitDuration',
      limits.maxDurationSeconds,
    ],
    [actual.sourcePixels, limits.maxSourcePixels, 'gif.limitPixels', limits.maxSourcePixels],
  ] as const;
  for (const [value, ceiling, message, limit] of checks) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error(t('gif.invalidLimits', {}, locale));
    if (value !== undefined && ceiling > 0 && value > ceiling)
      throw new GifLimitError(t(message, { limit }, locale));
  }
}
