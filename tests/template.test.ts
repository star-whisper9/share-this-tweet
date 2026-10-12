import { describe, expect, it } from 'vitest';
import {
  buildMediaFilename,
  buildCardFilename,
  buildSourcedMediaFilename,
  buildFrameFilename,
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

  it('renders avatar credits with an account and a second-line UTC timestamp', () => {
    expect(
      renderTemplate(
        '{author.avatar} {author.name} (@{author.handle})\n{tweet.publishedAt:YYYY-MM-DD HH:mm:ss}',
        {
          tweet: { ...record, publishedAt: '2026-09-07T18:00:01+08:00' },
          avatarMarker: 'AVATAR',
        },
      ),
    ).toBe('AVATAR Alice (@alice)\n2026-09-07 10:00:01');
  });
});

describe('buildMediaFilename', () => {
  it('formats archive dates and uses a fallback when the publishing date is unavailable', () => {
    const template =
      'X_{tweet.publishedAt:YYYYMMDD|undated}_{author.handle}_{tweet.id}_{media.index}.{extension}';
    expect(buildMediaFilename(record, photo, template)).toBe('X_20260907_alice_42_1.jpg');
    expect(buildMediaFilename({ ...record, publishedAt: undefined }, photo, template)).toBe(
      'X_undated_alice_42_1.jpg',
    );
  });
  it('sanitizes filename characters and forces the actual media extension', () => {
    expect(buildMediaFilename(record, photo, 'a:/bad name.gif')).toBe('a__bad name.jpg');
    expect(sanitizeFilename('  hello\nworld  ')).toBe('hello_world');
  });

  it('reserves a visible source suffix for long video filenames', () => {
    const video: MediaRecord = {
      index: 1,
      type: 'video',
      variants: [{ url: 'https://video.twimg.com/test.mp4', mime: 'video/mp4' }],
    };
    const filename = buildSourcedMediaFilename(record, video, `${'长'.repeat(180)}.mp4`);
    expect([...filename]).toHaveLength(180);
    expect(filename.endsWith('_source.mp4')).toBe(true);
  });

  it('reserves the frame suffix without splitting Unicode characters in long filenames', () => {
    const filename = buildFrameFilename(record, photo, `${'🌟'.repeat(180)}.jpg`);
    expect([...filename]).toHaveLength(180);
    expect(filename).toBe(`${'🌟'.repeat(169)}_framed.jpg`);
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
    expect(buildCardFilename(record, undefined, '{tweet.id}_{media.index}.{extension}')).toBe(
      '42_0_card.png',
    );
    expect(buildCardFilename(record, undefined, '{tweet.id}.{extension}')).toBe('42_card.png');
    expect(buildCardFilename(record, photo, '{tweet.id}_{media.index}.{extension}')).toBe(
      '42_1_card.png',
    );
    expect(() => buildCardFilename(record, undefined, '{media.type}.png')).toThrow(TemplateError);
    expect(() => renderTemplate('{media.index}', { tweet: record })).toThrow(TemplateError);
  });
});
