import { describe, expect, it } from 'vitest';
import {
  assertVideoLimits,
  DEFAULT_VIDEO_LIMITS,
  normalizeVideoLimits,
  VIDEO_LIMIT_PRESETS,
} from '../src/shared/video-experiment.js';
import { normalizeSettings, SETTINGS_STORAGE_KEY } from '../src/shared/settings.js';

describe('experimental processing limits', () => {
  it('migrates with rendering disabled and normalizes malformed limits', () => {
    expect(normalizeSettings({}).experimentalVideo).toBe(false);
    expect(
      normalizeSettings({ [SETTINGS_STORAGE_KEY]: { experimentalVideo: 'true' } })
        .experimentalVideo,
    ).toBe(false);
    expect(normalizeVideoLimits({ ...DEFAULT_VIDEO_LIMITS, maxFrameRate: NaN })).toEqual(
      DEFAULT_VIDEO_LIMITS,
    );
    expect(normalizeVideoLimits({ ...DEFAULT_VIDEO_LIMITS, maxOutputPixels: -1 })).toEqual(
      DEFAULT_VIDEO_LIMITS,
    );
    expect(normalizeVideoLimits(VIDEO_LIMIT_PRESETS[3].limits)).toEqual(
      VIDEO_LIMIT_PRESETS[3].limits,
    );
  });
  it('accepts boundaries, rejects exceeded guards and supports explicit unlimited values', () => {
    const actual = {
      inputBytes: 256 * 1048576,
      durationSeconds: 180,
      outputPixels: 4147200,
      frameRate: 30,
    };
    expect(() => assertVideoLimits(DEFAULT_VIDEO_LIMITS, actual)).not.toThrow();
    for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
      expect(() =>
        assertVideoLimits(DEFAULT_VIDEO_LIMITS, { ...actual, [key]: actual[key] + 1 }),
      ).toThrow();
    }
    expect(() =>
      assertVideoLimits(VIDEO_LIMIT_PRESETS[3].limits, {
        durationSeconds: 99999,
        inputBytes: 1e12,
      }),
    ).not.toThrow();
    expect(() => assertVideoLimits(DEFAULT_VIDEO_LIMITS, { frameRate: Infinity })).toThrow();
  });
});
