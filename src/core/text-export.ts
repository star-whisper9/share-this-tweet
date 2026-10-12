import { buildPollText } from '../shared/poll.js';
import type { TweetRecord } from '../shared/model.js';
import { catalogs, getLocale, t, type Locale } from '../shared/i18n.js';
import { renderTemplate } from './template.js';

export const LEGACY_TEXT_TEMPLATE =
  '{?translation.text}Grok · 翻译自 {translation.sourceLanguage}\n{translation.text}\n\nX · 原文：\n{/translation.text}{translation.originalText}\n\n{author.name} (@{author.handle})\n{tweet.url}';

export const LEGACY_POLL_TEXT_TEMPLATE =
  '{?translation.text}Grok · 翻译自 {translation.sourceLanguage}\n{translation.text}\n\n{/translation.text}{?poll.translatedText}{poll.translatedText}\n\n{/poll.translatedText}{?translation.text}X · 原文：\n{/translation.text}{translation.originalText}{?poll.originalText}\n\n{poll.originalText}{/poll.originalText}\n\n{author.name} (@{author.handle})\n{tweet.url}';

export const DEFAULT_TEXT_TEMPLATE =
  '{?translation.text}译文 · 原文语言：{translation.sourceLanguage}\n{translation.text}\n\n{/translation.text}{?poll.translatedText}{poll.translatedText}\n\n{/poll.translatedText}{?translation.text}原文：\n{/translation.text}{tweet.text}{?poll.originalText}\n\n{poll.originalText}{/poll.originalText}\n\n{author.name} (@{author.handle})\n{tweet.url}';

export const ORIGINAL_TEXT_TEMPLATE =
  '{tweet.text}{?poll.originalText}\n\n{poll.originalText}{/poll.originalText}\n\n{author.name} (@{author.handle})\n{tweet.url}';

export function getDefaultTextTemplate(locale: Locale = getLocale()): string {
  return t('core.text.defaultTemplate', {}, locale);
}

export function isDefaultTextTemplate(value: string): boolean {
  return (
    value === DEFAULT_TEXT_TEMPLATE ||
    [LEGACY_TEXT_TEMPLATE, LEGACY_POLL_TEXT_TEMPLATE].some(
      (legacy) =>
        value === legacy ||
        value === legacy.replace('翻译自', 'Translated from').replace('原文：', 'Original:'),
    ) ||
    (Object.keys(catalogs) as Locale[]).some((locale) => value === getDefaultTextTemplate(locale))
  );
}

export function buildTweetText(
  record: TweetRecord,
  template = getDefaultTextTemplate(),
  locale: Locale = getLocale(),
): string {
  // Validate poll data even when a custom template intentionally omits poll fields.
  const poll = buildPollText(record.poll, false, locale);
  const resolved = isDefaultTextTemplate(template) ? getDefaultTextTemplate(locale) : template;
  let main = renderTemplate(resolved, { tweet: record, locale });
  if (poll && !/\{(?:\?)?poll\./.test(resolved))
    main += `\n\n${t('core.poll.heading', {}, locale)}\n${poll}`;
  const quote = record.quote;
  if (!quote || template.includes('{quote.') || template.includes('{?quote.')) return main;
  const quoted = quote.record;
  const content = quoted
    ? buildTweetText(quoted, getDefaultTextTemplate(locale), locale)
    : [
        quote.status === 'unavailable'
          ? t('core.text.quoteUnavailable', {}, locale)
          : t('core.text.quotePending', {}, locale),
        quote.url,
      ]
        .filter(Boolean)
        .join('\n');
  return `${main}\n\n${t('core.text.quoteHeading', {}, locale)}\n${content}`;
}

async function copyWithSelectionFallback(text: string, locale: Locale): Promise<void> {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);

  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : [];
  const activeElement = document.activeElement;
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error(t('core.text.clipboardDenied', {}, locale));
  } finally {
    textarea.remove();
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
    if (activeElement instanceof HTMLElement && activeElement.isConnected)
      activeElement.focus({ preventScroll: true });
  }
}

export async function copyTweetText(
  record: TweetRecord,
  template = getDefaultTextTemplate(),
  locale: Locale = getLocale(),
): Promise<void> {
  const text = buildTweetText(record, template, locale);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await copyWithSelectionFallback(text, locale);
}
