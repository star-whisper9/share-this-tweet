import type { TweetRecord } from '../shared/model.js';
import { renderTemplate } from './template.js';

export const DEFAULT_TEXT_TEMPLATE =
  '{?translation.text}Grok · 翻译自 {translation.sourceLanguage}\n{translation.text}\n\nX · 原文：\n{/translation.text}{translation.originalText}\n\n{author.name} (@{author.handle})\n{tweet.url}';

export function buildTweetText(record: TweetRecord, template = DEFAULT_TEXT_TEMPLATE): string {
  const main = renderTemplate(template, { tweet: record });
  const quote = record.quote;
  if (!quote || template.includes('{quote.') || template.includes('{?quote.')) return main;
  const quoted = quote.record;
  const content = quoted
    ? renderTemplate(DEFAULT_TEXT_TEMPLATE, { tweet: quoted })
    : [quote.status === 'unavailable' ? '引用内容不可用' : '尚未获取引用内容', quote.url]
        .filter(Boolean)
        .join('\n');
  return `${main}\n\n── 引用推文 ──\n${content}`;
}

async function copyWithSelectionFallback(text: string): Promise<void> {
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
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝了剪贴板写入');
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
  template = DEFAULT_TEXT_TEMPLATE,
): Promise<void> {
  const text = buildTweetText(record, template);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await copyWithSelectionFallback(text);
}
