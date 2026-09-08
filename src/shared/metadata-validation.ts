import { validTranslation } from './translation.js';
/** Optional additions remain compatible with archives written before metadata support. */
export function validMetadata(value: Record<string, unknown>): boolean {
  if (!validTranslation(value.translation)) return false;
  if (value.translation && typeof value.translation === 'object') {
    const translation = value.translation as Record<string, unknown>;
    if (translation.status === 'available' && translation.originalText !== value.text) return false;
  }
  const text = (object: Record<string, unknown>, keys: string[]) =>
    keys.every(
      (key) =>
        object[key] === undefined ||
        (typeof object[key] === 'string' && (object[key] as string).length <= 100000),
    );
  const date = (object: Record<string, unknown>, key: string) =>
    object[key] === undefined ||
    (typeof object[key] === 'string' && Number.isFinite(Date.parse(object[key] as string)));
  if (!text(value, ['language', 'replyToTweetId', 'replyToUserId']) || !date(value, 'observedAt'))
    return false;
  if (value.sensitive !== undefined && typeof value.sensitive !== 'boolean') return false;
  if (
    value.textSource !== undefined &&
    !['partial', 'full', 'note'].includes(String(value.textSource))
  )
    return false;
  if (
    value.editIds !== undefined &&
    (!Array.isArray(value.editIds) ||
      value.editIds.length > 100 ||
      !value.editIds.every((id) => typeof id === 'string' && /^\d+$/.test(id)))
  )
    return false;
  const author = value.author as Record<string, unknown> | undefined;
  if (!author || !text(author, ['description', 'location', 'url']) || !date(author, 'createdAt'))
    return false;
  if (author.url !== undefined) {
    try {
      if (!['https:', 'http:'].includes(new URL(author.url as string).protocol)) return false;
    } catch {
      return false;
    }
  }
  if (!Array.isArray(value.media)) return false;
  return value.media.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const media = item as Record<string, unknown>;
    return (
      text(media, ['altText']) &&
      (media.durationMs === undefined ||
        (typeof media.durationMs === 'number' &&
          Number.isFinite(media.durationMs) &&
          media.durationMs >= 0))
    );
  });
}
