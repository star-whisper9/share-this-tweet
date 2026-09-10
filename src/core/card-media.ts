import type { MediaRecord } from '../shared/model.js';

const FALLBACK_PREVIEW_WIDTH = 1280;
const FALLBACK_PREVIEW_HEIGHT = 720;

export interface CardMediaPreview {
  url?: string;
  width: number;
  height: number;
}

/**
 * Pick only a still image that X has already supplied. Video bytes are never
 * requested for card rendering, and a missing still image remains a card slot.
 */
export function getCardMediaPreview(media: MediaRecord): CardMediaPreview {
  const width = validDimension(media.width) ? media.width : FALLBACK_PREVIEW_WIDTH;
  const height = validDimension(media.height) ? media.height : FALLBACK_PREVIEW_HEIGHT;
  return {
    ...(media.type === 'photo' ? { url: media.originalUrl } : { url: media.previewUrl }),
    width,
    height,
  };
}

export function formatCardMediaDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function validDimension(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
