import { describe, expect, it } from 'vitest';
import { getTweetIdFromPath, mergeTweetRecords, normalizeHandle } from '../src/shared/model.js';

describe('normalizeHandle', () => {
  it('keeps exactly one @ prefix', () => {
    expect(normalizeHandle('example')).toBe('@example');
    expect(normalizeHandle('@example')).toBe('@example');
    expect(normalizeHandle('@@example')).toBe('@example');
  });
});

describe('getTweetIdFromPath', () => {
  it('extracts a numeric status id from an X detail route', () => {
    expect(getTweetIdFromPath('/example/status/123456789/photo/1')).toBe('123456789');
  });

  it('rejects routes that are not tweet detail routes', () => {
    expect(getTweetIdFromPath('/home')).toBeUndefined();
    expect(getTweetIdFromPath('/example/status/not-a-number')).toBeUndefined();
  });
});

describe('mergeTweetRecords', () => {
  it('does not let a partial later record erase the author', () => {
    const complete = {
      tweetId: '42',
      url: 'https://x.com/alice/status/42',
      text: 'complete text',
      author: { id: '7', handle: 'alice', name: 'Alice' },
      media: [],
    };
    const partial = {
      tweetId: '42',
      url: 'https://x.com/i/status/42',
      text: 'complete text',
      author: { id: '7', handle: '', name: '' },
      media: [],
    };

    const merged = mergeTweetRecords(complete, partial);
    expect(merged.author.handle).toBe('alice');
    expect(merged.url).toBe('https://x.com/alice/status/42');
  });

  it('retains the existing dynamic-media preview while merging variants', () => {
    const base = {
      tweetId: '42',
      url: 'https://x.com/alice/status/42',
      text: '',
      author: { id: '7', handle: 'alice', name: 'Alice' },
      media: [
        {
          index: 1,
          type: 'video' as const,
          previewUrl: 'https://pbs.twimg.com/media/preview.jpg',
        },
      ],
    };
    const merged = mergeTweetRecords(base, { ...base, media: [{ index: 1, type: 'video' }] });
    expect(merged.media[0]?.previewUrl).toBe('https://pbs.twimg.com/media/preview.jpg');
  });
});
