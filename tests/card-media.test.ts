import { describe, expect, it } from 'vitest';
import { formatCardMediaDuration, getCardMediaPreview } from '../src/core/card-media.js';

describe('card media previews', () => {
  it('uses the original photo and the existing still preview for dynamic media', () => {
    expect(
      getCardMediaPreview({
        index: 1,
        type: 'photo',
        originalUrl: 'https://pbs.twimg.com/media/photo.jpg?name=orig',
        width: 1200,
        height: 800,
      }).url,
    ).toContain('photo.jpg');
    expect(
      getCardMediaPreview({
        index: 2,
        type: 'video',
        previewUrl: 'https://pbs.twimg.com/media/video-preview.jpg',
        width: 1920,
        height: 1080,
      }),
    ).toMatchObject({
      url: 'https://pbs.twimg.com/media/video-preview.jpg',
      width: 1920,
      height: 1080,
    });
  });

  it('keeps a layout slot when a dynamic-media preview is unavailable', () => {
    expect(getCardMediaPreview({ index: 1, type: 'animated_gif' })).toEqual({
      width: 1280,
      height: 720,
    });
  });
});

describe('card media duration', () => {
  it('formats known video duration and omits invalid values', () => {
    expect(formatCardMediaDuration(65_000)).toBe('1:05');
    expect(formatCardMediaDuration(-1)).toBeUndefined();
  });
});
