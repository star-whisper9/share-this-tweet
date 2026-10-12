import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  saveSettings,
} from '../src/shared/settings.js';

describe('normalizeSettings', () => {
  it('keeps valid templates and falls back from removed directions', () => {
    const settings = normalizeSettings({
      [SETTINGS_STORAGE_KEY]: {
        filenameTemplate: 'photo_{tweet.id}.png',
        frameOrientation: 'left',
      },
    });

    expect(settings.filenameTemplate).toBe('photo_{tweet.id}.png');
    expect(settings.frameOrientation).toBe('bottom');
    expect(settings.frameTemplate).toBe(DEFAULT_SETTINGS.frameTemplate);
    expect(settings.textTemplate).toBe(DEFAULT_SETTINGS.textTemplate);
  });

  it('rejects empty and malformed stored settings without breaking defaults', () => {
    expect(
      normalizeSettings({
        [SETTINGS_STORAGE_KEY]: {
          filenameTemplate: '',
          frameTemplate: 42,
          frameOrientation: 'diagonal',
        },
      }),
    ).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });
});

it('normalizes stitch preferences while migrating older settings', () => {
  const values = { [SETTINGS_STORAGE_KEY]: { stitchFrame: true, stitchStyle: 'gallery' } };
  expect(normalizeSettings(values)).toEqual({ ...DEFAULT_SETTINGS, stitchStyle: 'gallery' });
  expect(
    normalizeSettings({ [SETTINGS_STORAGE_KEY]: { stitchFrame: 'true', stitchStyle: 'other' } }),
  ).toEqual(DEFAULT_SETTINGS);
});

it('enables standalone GIF conversion by default and preserves independent GIF limits', () => {
  expect(normalizeSettings({}).experimentalGif).toBe(true);
  const gifLimits = { maxInputMiB: 8, maxDurationSeconds: 0, maxSourcePixels: 1000000 };
  expect(
    normalizeSettings({ [SETTINGS_STORAGE_KEY]: { experimentalGif: false, gifLimits } }),
  ).toMatchObject({ experimentalGif: false, gifLimits, videoLimits: DEFAULT_SETTINGS.videoLimits });
  for (const patch of [
    { experimentalGif: 'true' },
    { gifLimits: null },
    { gifLimits: { ...gifLimits, maxInputMiB: NaN } },
  ])
    expect(() => normalizeSettings({ [SETTINGS_STORAGE_KEY]: patch })).toThrow();
});

afterEach(() => vi.unstubAllGlobals());
it('persists GIF preferences separately from the video experiment and language', async () => {
  const set = vi.fn(async (_values: unknown) => {});
  vi.stubGlobal('browser', { storage: { local: { set } } });
  const gifLimits = { maxInputMiB: 0, maxDurationSeconds: 15, maxSourcePixels: 2000000 };
  await saveSettings({ ...DEFAULT_SETTINGS, experimentalGif: false, gifLimits });
  const stored = set.mock.calls[0]![0] as Record<string, unknown>;
  expect(normalizeSettings(stored)).toMatchObject({
    experimentalGif: false,
    gifLimits,
    experimentalVideo: false,
    videoLimits: DEFAULT_SETTINGS.videoLimits,
  });
  expect(stored[SETTINGS_STORAGE_KEY]).not.toHaveProperty('language');
});
