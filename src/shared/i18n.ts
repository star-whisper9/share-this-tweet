import { zhCN as videoZh, en as videoEn } from './locales/video.js';
import { zhCN as commonZh, en as commonEn } from './locales/common.js';
import { zhCN as contentZh, en as contentEn } from './locales/content.js';
import { zhCN as coreZh, en as coreEn } from './locales/core.js';
import { zhCN as optionsZh, en as optionsEn } from './locales/options.js';

export const SUPPORTED_LANGUAGES = ['auto', 'zh-CN', 'en'] as const;
export type LanguagePreference = (typeof SUPPORTED_LANGUAGES)[number];
export type Locale = Exclude<LanguagePreference, 'auto'>;
const zhCN = { ...videoZh, ...commonZh, ...contentZh, ...coreZh, ...optionsZh };
export type MessageKey = keyof typeof zhCN;
const en: Record<MessageKey, string> = {
  ...videoEn,
  ...commonEn,
  ...contentEn,
  ...coreEn,
  ...optionsEn,
};
export const catalogs: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zhCN, en };
let currentLocale: Locale = 'zh-CN';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return SUPPORTED_LANGUAGES.some((language) => language === value);
}
export function resolveLocale(language: LanguagePreference, browserLanguage?: string): Locale {
  if (language !== 'auto') return language;
  const detected =
    browserLanguage ??
    (typeof browser !== 'undefined' ? browser.i18n?.getUILanguage() : undefined) ??
    (typeof navigator !== 'undefined' ? navigator.language : 'zh-CN');
  return /^zh(?:-|$)/i.test(detected) ? 'zh-CN' : 'en';
}
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}
export function getLocale(): Locale {
  return currentLocale;
}

/** Parameters are inserted once, so user content cannot become another placeholder. */
export function t(
  key: MessageKey,
  params: Record<string, string | number> = {},
  locale = currentLocale,
): string {
  const message = catalogs[locale][key];
  if (message === undefined) throw new Error(`Unknown translation key: ${key}`);
  return message.replace(
    /\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (placeholder, name: string | undefined) => {
      if (placeholder === '{{') return '{';
      if (placeholder === '}}') return '}';
      if (!name) return placeholder;
      if (!Object.prototype.hasOwnProperty.call(params, name))
        throw new Error(`Missing translation parameter: ${key}.${name}`);
      return String(params[name]);
    },
  );
}

/** Translate only explicitly marked extension-owned nodes; never scan user text. */
export function localizeDocument(root: Document | HTMLElement = document): void {
  const targets: Array<[string, string | undefined]> = [
    ['data-i18n', undefined],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
    ['data-i18n-aria-label', 'aria-label'],
  ];
  for (const [marker, attribute] of targets) {
    const elements = Array.from(root.querySelectorAll<HTMLElement>(`[${marker}]`));
    if (root instanceof HTMLElement && root.hasAttribute(marker)) elements.unshift(root);
    for (const element of elements) {
      const value = t(element.getAttribute(marker) as MessageKey);
      if (attribute) element.setAttribute(attribute, value);
      else element.textContent = value;
    }
  }
  if (root instanceof Document) root.documentElement.lang = currentLocale;
  else root.lang = currentLocale;
}
