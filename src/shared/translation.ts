export type TweetTranslation =
  | { status: 'unavailable' }
  | { status: 'invalid'; reason: 'empty' | 'malformed' | 'stale' }
  | {
      status: 'available';
      text: string;
      originalText: string;
      sourceLanguage?: string;
      targetLanguage?: string;
      sourceLanguageName?: string;
      targetLanguageName?: string;
    };

const LANGUAGE_NAMES: Record<string, readonly [string, string]> = {
  en: ['英语', 'English'],
  zh: ['中文', 'Chinese'],
  'zh-cn': ['简体中文', 'Simplified Chinese'],
  'zh-hans': ['简体中文', 'Simplified Chinese'],
  'zh-tw': ['繁体中文', 'Traditional Chinese'],
  'zh-hant': ['繁体中文', 'Traditional Chinese'],
  ja: ['日语', 'Japanese'],
  ko: ['韩语', 'Korean'],
  fr: ['法语', 'French'],
  de: ['德语', 'German'],
  es: ['西班牙语', 'Spanish'],
  pt: ['葡萄牙语', 'Portuguese'],
  'pt-br': ['巴西葡萄牙语', 'Brazilian Portuguese'],
  ru: ['俄语', 'Russian'],
  ar: ['阿拉伯语', 'Arabic'],
  it: ['意大利语', 'Italian'],
  nl: ['荷兰语', 'Dutch'],
  tr: ['土耳其语', 'Turkish'],
  uk: ['乌克兰语', 'Ukrainian'],
  vi: ['越南语', 'Vietnamese'],
  th: ['泰语', 'Thai'],
  id: ['印度尼西亚语', 'Indonesian'],
  hi: ['印地语', 'Hindi'],
  pl: ['波兰语', 'Polish'],
  fa: ['波斯语', 'Persian'],
  he: ['希伯来语', 'Hebrew'],
  sv: ['瑞典语', 'Swedish'],
  fi: ['芬兰语', 'Finnish'],
  da: ['丹麦语', 'Danish'],
  no: ['挪威语', 'Norwegian'],
  cs: ['捷克语', 'Czech'],
};
export function languageName(
  code?: string,
  suppliedName?: string,
  locale: 'zh' | 'en' = 'zh',
): string {
  if (suppliedName?.trim()) return suppliedName.trim();
  if (!code) return '';
  return LANGUAGE_NAMES[code.toLowerCase().replace(/_/g, '-')]?.[locale === 'zh' ? 0 : 1] ?? code;
}
function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 100
    ? value.trim()
    : undefined;
}

/** Consume only the translation already embedded in X's response. Never request one. */
export function normalizeTranslation(
  value: unknown,
  originalText: string,
  originalLanguage?: string,
): TweetTranslation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return { status: 'invalid', reason: 'malformed' };
  const source = value as Record<string, unknown>;
  if (source.is_available === false) return { status: 'unavailable' };
  if (source.is_available !== true || !source.data || typeof source.data !== 'object')
    return { status: 'invalid', reason: 'malformed' };
  const data = source.data as Record<string, unknown>;
  if (typeof data.translation !== 'string' || data.translation.length > 100000)
    return { status: 'invalid', reason: 'malformed' };
  if (!data.translation.trim()) return { status: 'invalid', reason: 'empty' };
  const sourceLanguage = shortString(data.source_language) ?? originalLanguage;
  const targetLanguage = shortString(data.destination_language);
  if (
    sourceLanguage &&
    targetLanguage &&
    sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()
  )
    return { status: 'unavailable' };
  return {
    status: 'available',
    text: data.translation.trim(),
    originalText,
    sourceLanguage,
    targetLanguage,
    sourceLanguageName: shortString(data.source_language_name),
    targetLanguageName: shortString(data.destination_language_name),
  };
}

export function mergeTranslation(
  preferred: TweetTranslation | undefined,
  fallback: TweetTranslation | undefined,
  text: string,
): TweetTranslation | undefined {
  const translation = preferred ?? fallback;
  if (translation?.status === 'available' && translation.originalText !== text)
    return { status: 'invalid', reason: 'stale' };
  return translation;
}

export function translationWarning(translation?: TweetTranslation): string | undefined {
  if (translation?.status !== 'invalid') return undefined;
  return {
    empty: 'X 返回的译文为空，已回退为原文。',
    malformed: 'X 返回的翻译数据格式异常，已回退为原文。',
    stale: '译文与当前原文不匹配，已回退为原文。',
  }[translation.reason];
}

export function validTranslation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (item.status === 'unavailable') return true;
  if (item.status === 'invalid')
    return ['empty', 'malformed', 'stale'].includes(String(item.reason));
  return (
    item.status === 'available' &&
    typeof item.text === 'string' &&
    !!item.text.trim() &&
    item.text.length <= 100000 &&
    typeof item.originalText === 'string' &&
    item.originalText.length <= 100000 &&
    ['sourceLanguage', 'targetLanguage', 'sourceLanguageName', 'targetLanguageName'].every(
      (key) => item[key] === undefined || shortString(item[key]) !== undefined,
    )
  );
}
