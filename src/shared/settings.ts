import {
  DEFAULT_VIDEO_LIMITS,
  normalizeVideoLimits,
  type VideoLimits,
} from './video-experiment.js';
import { isLanguagePreference, resolveLocale, setLocale, type LanguagePreference } from './i18n.js';
import { DEFAULT_FILENAME_TEMPLATE } from '../core/filename.js';
import {
  DEFAULT_FRAME_ORIENTATION,
  DEFAULT_FRAME_TEMPLATE,
  type FrameOrientation,
} from '../core/frame.js';
import {
  DEFAULT_TEXT_TEMPLATE,
  getDefaultTextTemplate,
  isDefaultTextTemplate,
} from '../core/text-export.js';

export const SETTINGS_STORAGE_KEY = 'share-this-tweet.settings';
export const LANGUAGE_STORAGE_KEY = 'share-this-tweet.language';
let languageRevision = 0;
let latestLanguage: LanguagePreference | undefined;

export interface ExtensionSettings {
  language: LanguagePreference;
  experimentalVideo: boolean;
  videoLimits: VideoLimits;
  filenameTemplate: string;
  frameTemplate: string;
  frameOrientation: FrameOrientation;
  textTemplate: string;
  stitchStyle: 'seamless' | 'gallery';
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  language: 'auto',
  experimentalVideo: false,
  videoLimits: { ...DEFAULT_VIDEO_LIMITS },
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  frameTemplate: DEFAULT_FRAME_TEMPLATE,
  frameOrientation: DEFAULT_FRAME_ORIENTATION,
  textTemplate: DEFAULT_TEXT_TEMPLATE,
  stitchStyle: 'seamless',
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTemplate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function readOrientation(value: unknown): FrameOrientation {
  return value === 'top' || value === 'bottom' ? value : DEFAULT_SETTINGS.frameOrientation;
}

export function normalizeSettings(values: Record<string, unknown>): ExtensionSettings {
  const stored = asObject(values[SETTINGS_STORAGE_KEY]);
  const language = values[LANGUAGE_STORAGE_KEY] ?? stored?.language;
  return {
    experimentalVideo: stored?.experimentalVideo === true,
    videoLimits: normalizeVideoLimits(stored?.videoLimits),
    language: isLanguagePreference(language) ? language : DEFAULT_SETTINGS.language,
    filenameTemplate: readTemplate(stored?.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate),
    frameTemplate: readTemplate(stored?.frameTemplate, DEFAULT_SETTINGS.frameTemplate),
    frameOrientation: readOrientation(stored?.frameOrientation),
    stitchStyle: stored?.stitchStyle === 'gallery' ? 'gallery' : DEFAULT_SETTINGS.stitchStyle,
    textTemplate: readTemplate(stored?.textTemplate, DEFAULT_SETTINGS.textTemplate),
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const revision = languageRevision;
  const settings = normalizeSettings(
    await browser.storage.local.get([SETTINGS_STORAGE_KEY, LANGUAGE_STORAGE_KEY]),
  );
  // A slower read must not undo a language change already received by this page.
  if (revision !== languageRevision && latestLanguage) settings.language = latestLanguage;
  const locale = resolveLocale(settings.language);
  setLocale(locale);
  if (isDefaultTextTemplate(settings.textTemplate))
    settings.textTemplate = getDefaultTextTemplate(locale);
  return settings;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  // Language is saved independently: saving a stale template draft must not
  // overwrite a language change made in the popup.
  const { language: _language, ...templates } = settings;
  await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: templates });
}

export async function saveLanguage(language: LanguagePreference): Promise<void> {
  if (!isLanguagePreference(language)) throw new Error('Unsupported interface language');
  await browser.storage.local.set({ [LANGUAGE_STORAGE_KEY]: language });
  latestLanguage = language;
  languageRevision++;
  setLocale(resolveLocale(language));
}

export function watchLanguage(callback: (language: LanguagePreference) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
    if (areaName !== 'local' || !(LANGUAGE_STORAGE_KEY in changes)) return;
    const value = changes[LANGUAGE_STORAGE_KEY]?.newValue;
    const language = isLanguagePreference(value) ? value : DEFAULT_SETTINGS.language;
    latestLanguage = language;
    languageRevision++;
    setLocale(resolveLocale(language));
    callback(language);
  };
  browser.storage.onChanged?.addListener(listener);
  return () => browser.storage.onChanged?.removeListener(listener);
}
