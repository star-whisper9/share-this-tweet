import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, normalizeSettings } from '../src/shared/settings.js';

describe('normalizeSettings', () => {
  it('keeps valid templates and falls back from removed directions', () => {
    const settings = normalizeSettings({
      [SETTINGS_STORAGE_KEY]: { filenameTemplate: 'photo_{tweet.id}.png', frameOrientation: 'left' }
    });

    expect(settings.filenameTemplate).toBe('photo_{tweet.id}.png');
    expect(settings.frameOrientation).toBe('bottom');
    expect(settings.frameTemplate).toBe(DEFAULT_SETTINGS.frameTemplate);
    expect(settings.textTemplate).toBe(DEFAULT_SETTINGS.textTemplate);
  });

  it('rejects empty and malformed stored settings without breaking defaults', () => {
    expect(normalizeSettings({
      [SETTINGS_STORAGE_KEY]: { filenameTemplate: '', frameTemplate: 42, frameOrientation: 'diagonal' }
    })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });
});
