import { describe, expect, it } from 'vitest';
import {
  assertVideoLimits,
  DEFAULT_VIDEO_LIMITS,
  estimateVideoProcessing,
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
describe('processing estimate', () => {
  const input = {
    width: 720,
    height: 1378,
    durationSeconds: 135.666811,
    frameRate: 27,
    bitrateMbps: 1.5,
  };
  it('covers measured M4 cases and scales pixel-frame work, not compressed bitrate', () => {
    const result = estimateVideoProcessing(input);
    expect(result.minSeconds).toBeLessThan(219.545);
    expect(result.maxSeconds).toBeGreaterThan(219.545);
    const bigger = estimateVideoProcessing({ ...input, width: input.width * 2 });
    expect(bigger.minSeconds - 0.3).toBeCloseTo((result.minSeconds - 0.3) * 2);
    const bitrate = estimateVideoProcessing({ ...input, bitrateMbps: 3 });
    expect(bitrate.minSeconds).toBe(result.minSeconds);
    expect(bitrate.inputMiB).toBeCloseTo(result.inputMiB * 2);
  });
  it('rejects nonpositive, fractional dimensions and nonfinite calculator inputs', () => {
    for (const patch of [
      { frameRate: 0 },
      { width: 1.5 },
      { durationSeconds: NaN },
      { bitrateMbps: -1 },
    ])
      expect(() => estimateVideoProcessing({ ...input, ...patch })).toThrow();
  });
});
