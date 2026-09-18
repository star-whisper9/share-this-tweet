import type { TweetRecord } from '../shared/model.js';
import { catalogs, getLocale, t, type Locale } from '../shared/i18n.js';
import { renderTemplate } from './template.js';

export const DEFAULT_TEXT_TEMPLATE =
  '{?translation.text}Grok · 翻译自 {translation.sourceLanguage}\n{translation.text}\n\nX · 原文：\n{/translation.text}{translation.originalText}\n\n{author.name} (@{author.handle})\n{tweet.url}';

export function getDefaultTextTemplate(locale: Locale = getLocale()): string {
  return t('core.text.defaultTemplate', {}, locale);
}

export function isDefaultTextTemplate(value: string): boolean {
  return (
    value === DEFAULT_TEXT_TEMPLATE ||
    (Object.keys(catalogs) as Locale[]).some((locale) => value === getDefaultTextTemplate(locale))
  );
}

export function buildTweetText(
  record: TweetRecord,
  template = getDefaultTextTemplate(),
  locale: Locale = getLocale(),
): string {
  const main = renderTemplate(template, { tweet: record, locale });
  const quote = record.quote;
  if (!quote || template.includes('{quote.') || template.includes('{?quote.')) return main;
  const quoted = quote.record;
  const content = quoted
    ? renderTemplate(getDefaultTextTemplate(locale), { tweet: quoted, locale })
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
