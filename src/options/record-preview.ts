import type { TweetRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';

export function recordPreviewText(record: TweetRecord): string {
  const quote = record.quote;
  const quotedText =
    quote?.record?.text ??
    (quote?.status === 'unavailable'
      ? t('options.records.quoteUnavailable')
      : t('options.records.quotePending'));
  return [
    record.text || t('options.records.noText'),
    quote
      ? [
          t('options.records.quote'),
          quote.record ? `${quote.record.author.name} · @${quote.record.author.handle}` : '',
          quotedText,
          quote.tweetId ? `https://x.com/i/status/${quote.tweetId}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
