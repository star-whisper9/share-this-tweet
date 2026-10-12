import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';
import { getMediaDownloadTarget } from './media.js';
import { renderTemplate } from './template.js';

export const DEFAULT_FILENAME_TEMPLATE =
  'X_{tweet.publishedAt:YYYYMMDD|undated}_{author.handle}_{tweet.id}_{media.index}.{extension}';

const ILLEGAL_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_FILENAME_LENGTH = 180;

export function sanitizeFilename(value: string): string {
  const sanitized = value
    .replace(ILLEGAL_FILENAME_CHARACTERS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\.+|\s+)$/, '_');
  if (!sanitized) throw new Error(t('core.filename.empty'));
  return [...sanitized].slice(0, MAX_FILENAME_LENGTH).join('');
}

function finishFilename(filename: string, extension: string, modifier = ''): string {
  const suffix = `${modifier}.${extension}`;
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  const maxBaseLength = Math.max(1, MAX_FILENAME_LENGTH - suffix.length);
  const base = [...(withoutExtension || 'download')].slice(0, maxBaseLength).join('');
  return `${base}${suffix}`;
}

export function buildMediaFilename(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
  extension?: 'gif' | 'mp4',
): string {
  const target = getMediaDownloadTarget(media);
  const outputExtension = extension ?? target.extension;
  const rendered = renderTemplate(template, {
    tweet: record,
    media,
    extension: outputExtension,
  });
  return finishFilename(sanitizeFilename(rendered), outputExtension);
}

export function buildSourcedMediaFilename(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
  outputExtension?: 'gif' | 'mp4',
): string {
  const filename = buildMediaFilename(record, media, template, outputExtension);
  const extension = outputExtension ?? getMediaDownloadTarget(media).extension;
  return finishFilename(filename, extension, '_source');
}

export function buildFrameFilename(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
  extension: 'jpg' | 'webp' | 'mp4' = 'jpg',
): string {
  const rendered = renderTemplate(template, { tweet: record, media, extension });
  return finishFilename(sanitizeFilename(rendered), extension, '_framed');
}

export function buildCardFilename(
  record: TweetRecord,
  media?: MediaRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
  row = false,
): string {
  const rendered = renderTemplate(template, {
    tweet: record,
    media,
    extension: 'png',
    card: true,
  });
  return finishFilename(sanitizeFilename(rendered), 'png', row ? '_row_card' : '_card');
}

export function buildStitchFilename(
  record: TweetRecord,
  template = DEFAULT_FILENAME_TEMPLATE,
  extension: 'png' | 'jpg' | 'webp' | 'mp4' = 'png',
  framed = false,
): string {
  const rendered = renderTemplate(template, { tweet: record, media: record.media[0], extension });
  return finishFilename(
    sanitizeFilename(rendered),
    extension,
    framed ? '_stitched_framed' : '_stitched',
  );
}
