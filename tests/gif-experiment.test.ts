import { expect, it } from 'vitest';
import {
  assertGifLimits,
  DEFAULT_GIF_LIMITS,
  GifLimitError,
  isGifLimits,
  normalizeGifLimits,
} from '../src/shared/gif-experiment.js';
import { VideoLimitError } from '../src/shared/video-experiment.js';

it('defaults missing GIF limits and rejects explicitly malformed limits', () => {
  expect(normalizeGifLimits(undefined)).toEqual(DEFAULT_GIF_LIMITS);
  for (const value of [
    null,
    [],
    {},
    { ...DEFAULT_GIF_LIMITS, maxSourcePixels: 1.5 },
    { ...DEFAULT_GIF_LIMITS, maxInputMiB: -1 },
    { ...DEFAULT_GIF_LIMITS, maxDurationSeconds: Infinity },
  ]) {
    expect(isGifLimits(value)).toBe(false);
    expect(() => normalizeGifLimits(value)).toThrow();
  }
});
it('checks source boundaries and identifies exceeded guards for explicit fallback', () => {
  const actual = { inputBytes: 64 * 1048576, durationSeconds: 60, sourcePixels: 8294400 };
  expect(() => assertGifLimits(DEFAULT_GIF_LIMITS, actual)).not.toThrow();
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    expect(() =>
      assertGifLimits(DEFAULT_GIF_LIMITS, { ...actual, [key]: actual[key] + 1 }),
    ).toThrow(GifLimitError);
  }
  expect(() =>
    assertGifLimits(DEFAULT_GIF_LIMITS, { sourcePixels: actual.sourcePixels + 1 }),
  ).toThrow(VideoLimitError);
  expect(() =>
    assertGifLimits({ maxInputMiB: 0, maxDurationSeconds: 0, maxSourcePixels: 0 }, actual),
  ).not.toThrow();
  expect(() => assertGifLimits(DEFAULT_GIF_LIMITS, { sourcePixels: Infinity })).toThrow();
});
