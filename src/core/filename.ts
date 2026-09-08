import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { getMediaDownloadTarget } from './media.js';
import { renderTemplate } from './template.js';

export const DEFAULT_FILENAME_TEMPLATE = 'X_{author.handle}_t{tweet.id}_m{media.index}.{extension}';

const ILLEGAL_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_FILENAME_LENGTH = 180;

export function sanitizeFilename(value: string): string {
  const sanitized = value
    .replace(ILLEGAL_FILENAME_CHARACTERS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\.+|\s+)$/, '_');
  if (!sanitized) throw new Error('模板渲染后文件名为空');
  return [...sanitized].slice(0, MAX_FILENAME_LENGTH).join('');
}

function forceExtension(filename: string, extension: string): string {
  const suffix = `.${extension}`;
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  const maxBaseLength = Math.max(1, MAX_FILENAME_LENGTH - suffix.length);
  const base = [...(withoutExtension || 'download')].slice(0, maxBaseLength).join('');
  return `${base}${suffix}`;
}

export function buildMediaFilename(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
): string {
  const target = getMediaDownloadTarget(media);
  const rendered = renderTemplate(template, {
    tweet: record,
    media,
    extension: target.extension,
  });
  return forceExtension(sanitizeFilename(rendered), target.extension);
}

export function buildFrameFilename(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
  extension: 'jpg' | 'webp' = 'jpg',
): string {
  const rendered = renderTemplate(template, { tweet: record, media, extension });
  const base = forceExtension(sanitizeFilename(rendered), extension).slice(
    0,
    -(extension.length + 1),
  );
  return forceExtension(`${base}_framed.${extension}`, extension);
}

export function buildCardFilename(
  record: TweetRecord,
  media?: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
): string {
  const rendered = renderTemplate(template, {
    tweet: record,
    media,
    extension: 'png',
    card: true,
  });
  const base = forceExtension(sanitizeFilename(rendered), 'png').slice(0, -4);
  return forceExtension(`${base}_card.png`, 'png');
}
