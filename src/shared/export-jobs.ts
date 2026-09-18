import type { TweetRecord } from './model.js';
import type { ExtensionSettings } from './settings.js';
import { isLanguagePreference, isLocale, type Locale } from './i18n.js';
import type { ImageTheme } from '../core/image-theme.js';
import type { OutputRecordInput } from './storage-model.js';
import { isVideoLimits } from './video-experiment.js';
import { validMetadata } from './metadata-validation.js';

export type ExportJobKind = 'media' | 'stitch' | 'card' | 'row-card';
export interface ExportJobRequest {
  id: string;
  kind: ExportJobKind;
  record: TweetRecord;
  settings: ExtensionSettings;
  theme: ImageTheme;
  locale: Locale;
  media?: Array<{
    index: number;
    mode: 'original' | 'sourced' | 'framed';
    orientation: 'top' | 'bottom';
  }>;
  frame?: 'original' | 'top' | 'bottom';
}
export interface ExportJobFile {
  id: string;
  filename: string;
  blob: Blob;
  output: OutputRecordInput;
}
export type ExportJobStatus =
  'queued' | 'running' | 'ready' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'expired';
export interface JobSummary {
  id: string;
  kind: ExportJobKind;
  tweetId: string;
  author: string;
  createdAt: string;
  status: ExportJobStatus;
  progress?: string;
  error?: string;
  warnings: string[];
  files: Array<{
    id: string;
    filename: string;
    size: number;
    saved: boolean;
    cached: boolean;
    cacheExpiresAt: number;
  }>;
  hasDiagnostics: boolean;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 100000): value is string {
  return typeof value === 'string' && value.length <= max;
}
function mediaURL(value: unknown): boolean {
  if (value === undefined) return true;
  if (!text(value, 4096)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function record(value: unknown, depth = 0): value is TweetRecord {
  if (
    !object(value) ||
    !text(value.tweetId, 64) ||
    !/^\d+$/.test(value.tweetId) ||
    !text(value.url, 4096) ||
    !text(value.text) ||
    !object(value.author) ||
    !text(value.author.id, 64) ||
    !text(value.author.name, 1000) ||
    !text(value.author.handle, 1000) ||
    !mediaURL(value.author.avatarUrl) ||
    !Array.isArray(value.media) ||
    value.media.length > 4 ||
    !validMetadata(value)
  )
    return false;
  if (
    !value.media.every(
      (item) =>
        object(item) &&
        Number.isInteger(item.index) &&
        Number(item.index) > 0 &&
        ['photo', 'video', 'animated_gif'].includes(String(item.type)) &&
        mediaURL(item.originalUrl) &&
        mediaURL(item.previewUrl) &&
        (item.variants === undefined ||
          (Array.isArray(item.variants) &&
            item.variants.length <= 32 &&
            item.variants.every(
              (v) => object(v) && typeof v.url === 'string' && mediaURL(v.url) && text(v.mime, 100),
            ))),
    )
  )
    return false;
  if (new Set(value.media.map((m) => m.index)).size !== value.media.length) return false;
  if (value.quote !== undefined) {
    if (
      depth ||
      !object(value.quote) ||
      !['pending', 'unavailable', 'available'].includes(String(value.quote.status))
    )
      return false;
    if (value.quote.record !== undefined && !record(value.quote.record, depth + 1)) return false;
  }
  return true;
}
/** Validate every URL that background rendering can fetch before accepting a job. */
export function isExportJobRequest(value: unknown): value is ExportJobRequest {
  if (
    !object(value) ||
    !text(value.id, 80) ||
    !value.id ||
    !['media', 'stitch', 'card', 'row-card'].includes(String(value.kind)) ||
    !record(value.record) ||
    !isLocale(value.locale) ||
    !['light', 'dark'].includes(String(value.theme)) ||
    !object(value.settings)
  )
    return false;
  const s = value.settings;
  if (
    !isLanguagePreference(s.language) ||
    typeof s.experimentalVideo !== 'boolean' ||
    !isVideoLimits(s.videoLimits) ||
    !['top', 'bottom'].includes(String(s.frameOrientation)) ||
    !['seamless', 'gallery'].includes(String(s.stitchStyle)) ||
    !['filenameTemplate', 'frameTemplate', 'textTemplate'].every(
      (k) => text(s[k], 10000) && String(s[k]).trim().length > 0,
    )
  )
    return false;
  if (value.kind === 'stitch')
    return (
      value.record.media.length > 1 && ['original', 'top', 'bottom'].includes(String(value.frame))
    );
  if (value.kind !== 'media') return true;
  const tweet = value.record;
  return (
    Array.isArray(value.media) &&
    value.media.length > 0 &&
    value.media.length <= 4 &&
    new Set(value.media.map((m) => (object(m) ? m.index : undefined))).size ===
      value.media.length &&
    value.media.every(
      (m) =>
        object(m) &&
        tweet.media.some((item) => item.index === m.index) &&
        ['original', 'sourced', 'framed'].includes(String(m.mode)) &&
        ['top', 'bottom'].includes(String(m.orientation)),
    )
  );
}
