import { isDefaultTextTemplate } from '../src/core/text-export.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  catalogs,
  getLocale,
  isLanguagePreference,
  resolveLocale,
  setLocale,
  t,
  type MessageKey,
} from '../src/shared/i18n.js';
import {
  DEFAULT_SETTINGS,
  LANGUAGE_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  normalizeSettings,
  saveLanguage,
  saveSettings,
  watchLanguage,
} from '../src/shared/settings.js';

function placeholders(message: string): string[] {
  return Array.from(message.matchAll(/\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g), (match) => match[1])
    .filter((name): name is string => !!name)
    .sort();
}
afterEach(() => {
  setLocale('zh-CN');
  vi.unstubAllGlobals();
});
describe('language resources', () => {
  it('ships matching keys and interpolation parameters for every language', () => {
    const keys = Object.keys(catalogs['zh-CN']) as MessageKey[];
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
      for (const key of keys)
        expect(placeholders(catalog[key]), key).toEqual(placeholders(catalogs['zh-CN'][key]));
    }
  });
  it('only accepts known language preferences and resolves browser language', () => {
    expect(isLanguagePreference('en')).toBe(true);
    expect(isLanguagePreference('zh-CN')).toBe(true);
    expect(isLanguagePreference('auto')).toBe(true);
    expect(isLanguagePreference('xx')).toBe(false);
    expect(resolveLocale('auto', 'zh-TW')).toBe('zh-CN');
    expect(resolveLocale('auto', 'en-GB')).toBe('en');
    expect(resolveLocale('auto', 'fr')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });
  it('does not recursively interpolate or translate user-provided parameters', () => {
    const content = '<b>{error}</b> 用户原文';
    const result = t('popup.loadError', { error: content }, 'en');
    expect(result.includes(content)).toBe(true);
    expect(result.split(content)).toHaveLength(2);
    expect(() => t('popup.loadError', {}, 'en')).toThrow();
  });
  it('uses valid translation keys in static extension pages', () => {
    for (const file of ['popup/popup.html', 'options/options.html', 'tasks/tasks.html']) {
      const html = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      const markers = html.matchAll(/data-i18n(?:-(?:aria-label|placeholder|title))?="([^"]+)"/g);
      for (const [, key] of markers) expect(Object.hasOwn(catalogs.en, key!), key).toBe(true);
    }
  });
});
describe('language preference storage', () => {
  it('saves language independently without replacing template preferences', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set } } });
    await saveLanguage('en');
    expect(set).toHaveBeenLastCalledWith({ [LANGUAGE_STORAGE_KEY]: 'en' });
    expect(getLocale()).toBe('en');
    await saveSettings({ ...DEFAULT_SETTINGS, language: 'zh-CN', textTemplate: 'my custom text' });
    expect(Object.keys(set.mock.calls[1][0])).toEqual([SETTINGS_STORAGE_KEY]);
    expect(set.mock.calls[1][0][SETTINGS_STORAGE_KEY].textTemplate).toBe('my custom text');
  });
  it('preserves customized template bytes on load and normalizes invalid preferences', async () => {
    const custom = '原文：{tweet.text}\n{tweet.url}';
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, textTemplate: custom },
            [LANGUAGE_STORAGE_KEY]: 'en',
          }),
        },
      },
    });
    const settings = await loadSettings();
    expect(settings.textTemplate).toBe(custom);
    expect(settings.language).toBe('en');
    expect(getLocale()).toBe('en');
    expect(normalizeSettings({ [LANGUAGE_STORAGE_KEY]: 'invalid' }).language).toBe('auto');
  });
  it('localizes only recognized built-in templates and can switch back without rewriting storage', async () => {
    const get = vi.fn().mockResolvedValue({
      [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
      [LANGUAGE_STORAGE_KEY]: 'en',
    });
    const set = vi.fn();
    vi.stubGlobal('browser', { storage: { local: { get, set } } });
    const english = await loadSettings();
    expect(isDefaultTextTemplate(english.textTemplate)).toBe(true);
    expect(english.textTemplate).not.toBe(DEFAULT_SETTINGS.textTemplate);
    get.mockResolvedValueOnce({
      [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, textTemplate: english.textTemplate },
      [LANGUAGE_STORAGE_KEY]: 'zh-CN',
    });
    const chinese = await loadSettings();
    expect(chinese.textTemplate).toBe(DEFAULT_SETTINGS.textTemplate);
    expect(set).not.toHaveBeenCalled();
  });
  it('does not let a slow settings read undo a language change', async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    vi.stubGlobal('browser', {
      storage: { local: { get: () => pending, set: vi.fn().mockResolvedValue(undefined) } },
    });
    const loading = loadSettings();
    await saveLanguage('en');
    resolve({ [LANGUAGE_STORAGE_KEY]: 'zh-CN' });
    expect((await loading).language).toBe('en');
    expect(getLocale()).toBe('en');
  });
  it('notifies active extension surfaces and releases the storage listener', () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('browser', { storage: { onChanged: { addListener, removeListener } } });
    const changed = vi.fn();
    const stop = watchLanguage(changed);
    const listener = addListener.mock.calls[0][0];
    listener({ [LANGUAGE_STORAGE_KEY]: { newValue: 'en' } }, 'local');
    expect(getLocale()).toBe('en');
    expect(changed).toHaveBeenCalledWith('en');
    listener({ unrelated: { newValue: 'zh-CN' } }, 'local');
    expect(changed).toHaveBeenCalledOnce();
    stop();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
});

it('resolves every public template field description after a language switch', async () => {
  const { fieldsForScope } = await import('../src/core/template.js');
  for (const locale of ['zh-CN', 'en'] as const) {
    setLocale(locale);
    for (const scope of ['filenameTemplate', 'frameTemplate', 'textTemplate'] as const) {
      for (const field of fieldsForScope(scope)) {
        expect(field.label.length, field.name).toBeGreaterThan(0);
        expect(field.description.length, field.name).toBeGreaterThan(0);
      }
    }
  }
});
