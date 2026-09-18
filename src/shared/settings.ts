import { DEFAULT_FILENAME_TEMPLATE } from '../core/filename.js';
import {
  DEFAULT_FRAME_ORIENTATION,
  DEFAULT_FRAME_TEMPLATE,
  type FrameOrientation,
} from '../core/frame.js';
import { DEFAULT_TEXT_TEMPLATE } from '../core/text-export.js';

export const SETTINGS_STORAGE_KEY = 'share-this-tweet.settings';

export interface ExtensionSettings {
  filenameTemplate: string;
  frameTemplate: string;
  frameOrientation: FrameOrientation;
  textTemplate: string;
  stitchFrame: boolean;
  stitchStyle: 'seamless' | 'gallery';
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  frameTemplate: DEFAULT_FRAME_TEMPLATE,
  frameOrientation: DEFAULT_FRAME_ORIENTATION,
  textTemplate: DEFAULT_TEXT_TEMPLATE,
  stitchFrame: false,
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
  return {
    filenameTemplate: readTemplate(stored?.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate),
    frameTemplate: readTemplate(stored?.frameTemplate, DEFAULT_SETTINGS.frameTemplate),
    frameOrientation: readOrientation(stored?.frameOrientation),
    stitchFrame:
      typeof stored?.stitchFrame === 'boolean' ? stored.stitchFrame : DEFAULT_SETTINGS.stitchFrame,
    stitchStyle: stored?.stitchStyle === 'gallery' ? 'gallery' : DEFAULT_SETTINGS.stitchStyle,
    textTemplate: readTemplate(stored?.textTemplate, DEFAULT_SETTINGS.textTemplate),
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  return normalizeSettings(await browser.storage.local.get(SETTINGS_STORAGE_KEY));
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}
