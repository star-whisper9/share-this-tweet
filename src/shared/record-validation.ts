import type { TweetRecord } from './model.js';
import { validMetadata } from './metadata-validation.js';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isRecordTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Validate stored data shapes; callers enforce their own network and size policies. */
export function isTweetRecord(value: unknown, allowQuote = true): value is TweetRecord {
  if (
    !object(value) ||
    typeof value.tweetId !== 'string' ||
    !/^\d+$/.test(value.tweetId) ||
    typeof value.url !== 'string' ||
    typeof value.text !== 'string' ||
    !object(value.author) ||
    typeof value.author.id !== 'string' ||
    typeof value.author.handle !== 'string' ||
    typeof value.author.name !== 'string' ||
    !optionalText(value.author.avatarUrl) ||
    (value.publishedAt !== undefined && !isRecordTimestamp(value.publishedAt)) ||
    !Array.isArray(value.media) ||
    !validMetadata(value)
  )
    return false;
  if (
    !value.media.every(
      (media) =>
        object(media) &&
        Number.isSafeInteger(media.index) &&
        Number(media.index) > 0 &&
        ['photo', 'video', 'animated_gif'].includes(String(media.type)) &&
        optionalText(media.originalUrl) &&
        ['width', 'height'].every(
          (key) =>
            media[key] === undefined ||
            (typeof media[key] === 'number' && Number.isFinite(media[key]) && media[key] > 0),
        ) &&
        (media.variants === undefined ||
          (Array.isArray(media.variants) &&
            media.variants.every(
              (variant) =>
                object(variant) &&
                typeof variant.url === 'string' &&
                typeof variant.mime === 'string' &&
                (variant.bitrate === undefined ||
                  (typeof variant.bitrate === 'number' &&
                    Number.isFinite(variant.bitrate) &&
                    variant.bitrate >= 0)),
            ))),
    ) ||
    new Set(value.media.map((media) => media.index)).size !== value.media.length
  )
    return false;
  if (value.quote === undefined) return true;
  const quote = value.quote;
  if (
    !allowQuote ||
    !object(quote) ||
    !['available', 'pending', 'unavailable'].includes(String(quote.status)) ||
    (quote.tweetId !== undefined &&
      (typeof quote.tweetId !== 'string' ||
        !/^\d+$/.test(quote.tweetId) ||
        quote.tweetId === value.tweetId)) ||
    (quote.url !== undefined &&
      (typeof quote.url !== 'string' || !/^https:\/\/(?:x\.com|twitter\.com)\//.test(quote.url)))
  )
    return false;
  return quote.status === 'available'
    ? isTweetRecord(quote.record, false) && quote.record.tweetId === quote.tweetId
    : quote.record === undefined;
}
