import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILENAME_TEMPLATE,
  buildMediaFilename,
  buildCardFilename,
  sanitizeFilename,
} from '../src/core/filename.js';
import { getMediaDownloadTarget } from '../src/core/media.js';
import { renderTemplate, TemplateError } from '../src/core/template.js';
import type { MediaRecord, TweetRecord } from '../src/shared/model.js';

const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/alice/status/42',
  text: 'hello\nworld',
  author: {
    id: '7',
    handle: '@alice',
    name: 'Alice',
    avatarUrl: 'https://pbs.twimg.com/profile_images/alice.png',
  },
  publishedAt: '2026-09-07T10:00:00.000Z',
  media: [],
};

const photo: MediaRecord = {
  index: 1,
  type: 'photo',
  originalUrl: 'https://pbs.twimg.com/media/photo.jpg?format=jpg&name=orig',
};

describe('renderTemplate', () => {
  it('renders tweet, author, media and formatted date values', () => {
    expect(
      renderTemplate('{author.handle}_{tweet.id}_{tweet.publishedAt:YYYY-MM-DD}_{media.index}', {
        tweet: record,
        media: photo,
        extension: 'jpg',
      }),
    ).toBe('alice_42_2026-09-07_1');
    expect(
      renderTemplate('{author.avatar}', {
        tweet: record,
        media: photo,
        extension: 'jpg',
      }),
    ).toBe('https://pbs.twimg.com/profile_images/alice.png');
  });

  it('rejects unknown fields, unavailable values and malformed syntax', () => {
    const context = { tweet: record, media: photo, extension: 'jpg' };
    expect(() => renderTemplate('{tweet.unknown}', context)).toThrow(TemplateError);
    expect(() => renderTemplate('{tweet.publishedAt:MM/DD}', context)).toThrow(TemplateError);
    expect(() => renderTemplate('{tweet.url', context)).toThrow(TemplateError);
    expect(() => renderTemplate('value}', context)).toThrow(TemplateError);
  });
});

describe('buildMediaFilename', () => {
  it('uses the default template and the photo extension from the media URL', () => {
    expect(buildMediaFilename(record, photo)).toBe('X_alice_t42_m1.jpg');
    expect(DEFAULT_FILENAME_TEMPLATE).toContain('{tweet.id}');
  });

  it('sanitizes filename characters and forces the actual media extension', () => {
    expect(buildMediaFilename(record, photo, 'a:/bad name.gif')).toBe('a__bad name.jpg');
    expect(sanitizeFilename('  hello\nworld  ')).toBe('hello_world');
  });
});

describe('media download target', () => {
  it('selects the highest bitrate MP4 and never treats GIF as a GIF file', () => {
    const media: MediaRecord = {
      index: 1,
      type: 'animated_gif',
      variants: [
        { url: 'https://video.twimg.com/low.mp4', mime: 'video/mp4', bitrate: 64000 },
        { url: 'https://video.twimg.com/high.webm', mime: 'video/webm', bitrate: 999999 },
        { url: 'https://video.twimg.com/high.mp4', mime: 'video/mp4', bitrate: 128000 },
      ],
    };
    expect(getMediaDownloadTarget(media)).toEqual({
      url: 'https://video.twimg.com/high.mp4',
      extension: 'mp4',
    });
  });
});

describe('card filenames', () => {
  it('names text-only cards without inventing a media record', () => {
    expect(buildCardFilename(record)).toBe('X_alice_t42_m0_card.png');
    expect(buildCardFilename(record, undefined, '{tweet.id}.{extension}')).toBe('42_card.png');
    expect(buildCardFilename(record, photo)).toBe('X_alice_t42_m1_card.png');
    expect(() => buildCardFilename(record, undefined, '{media.type}.png')).toThrow(TemplateError);
    expect(() => renderTemplate('{media.index}', { tweet: record })).toThrow(TemplateError);
  });
});
