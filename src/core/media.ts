import type { MediaRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';

export interface MediaDownloadTarget {
  url: string;
  extension: string;
}

function normalizeExtension(value: string): string {
  const extension = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!extension) throw new Error(t('core.media.missingExtension'));
  return extension === 'jpeg' ? 'jpg' : extension;
}

function getPhotoExtension(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(t('core.media.invalidPhotoUrl'));
  }

  const format = parsed.searchParams.get('format');
  if (format) return normalizeExtension(format);
  const pathExtension = parsed.pathname.match(/\.([a-z0-9]+)$/i)?.[1];
  if (pathExtension) return normalizeExtension(pathExtension);
  throw new Error(t('core.media.photoMissingExtension'));
}

export function chooseVideoVariant(media: MediaRecord): string {
  const variant = (media.variants ?? [])
    .filter((candidate) => candidate.mime.split(';', 1)[0].trim().toLowerCase() === 'video/mp4')
    .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
  if (!variant) throw new Error(t('core.media.noMp4Variant'));
  return variant.url;
}

export function getMediaDownloadTarget(media: MediaRecord): MediaDownloadTarget {
  if (media.type === 'photo') {
    if (!media.originalUrl) throw new Error(t('core.media.originalUnavailable'));
    return { url: media.originalUrl, extension: getPhotoExtension(media.originalUrl) };
  }

  return { url: chooseVideoVariant(media), extension: 'mp4' };
}
