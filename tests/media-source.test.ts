import { describe, expect, it } from 'vitest';
import {
  createMediaSourceMetadata,
  parseMediaSourceMetadata,
  type MediaSourceMetadata,
} from '../src/shared/media-source.js';
import type { TweetRecord } from '../src/shared/model.js';

const record: TweetRecord = {
  tweetId: '12345',
  url: 'https://x.com/test/status/12345',
  text: '',
  author: { id: '56789', handle: 'test', name: '测试发布者' },
  publishedAt: '2026-09-10T00:00:00Z',
  media: [{ index: 1, type: 'animated_gif' }],
};
const source = createMediaSourceMetadata(record, record.media[0], '0.4.0');

describe('file source metadata contract', () => {
  it('retains publisher and media identity without inventing ownership', () => {
    expect(source.publisher).toEqual({ id: '56789', handle: '@test', name: '测试发布者' });
    expect(source.media).toEqual({ index: 1, type: 'animated_gif' });
    expect(source.tweetUrl).toBe(record.url);
    expect(source.publishedAt).toBe(record.publishedAt);
    expect(parseMediaSourceMetadata({ ...source, copyright: 'not a verified claim' })).toEqual(
      source,
    );
    const withoutId = createMediaSourceMetadata(
      { ...record, author: { ...record.author, id: '' } },
      record.media[0],
      '0.4.0',
    );
    expect(withoutId.publisher.id).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'http://x.com/test/status/12345',
    'https://x.com.evil.test/test/status/12345',
    'https://attacker@x.com/test/status/12345',
    'https://x.com/test/status/67890',
    'https://x.com/test/status/12345#fragment',
    'https://x.com/test/status/12345?redirect=other',
    'https://x.com/%74est/status/12345',
  ])('rejects unsafe or noncanonical tweet source URLs: %s', (tweetUrl) => {
    expect(() => parseMediaSourceMetadata({ ...source, tweetUrl })).toThrow();
  });

  it('bounds field sizes and rejects unknown schema, invalid identities, types and timestamps', () => {
    const invalid: unknown[] = [
      { ...source, schemaVersion: 2 },
      { ...source, tweetId: '0' },
      { ...source, publisher: { ...source.publisher, name: 'x'.repeat(257) } },
      { ...source, publisher: { ...source.publisher, handle: '@invalid space' } },
      { ...source, publisher: { ...source.publisher, id: '1.5' } },
      { ...source, media: { index: 5, type: 'video' } },
      { ...source, media: { index: 1, type: 'photo' } },
      { ...source, publishedAt: 'invalid date' },
      { ...source, publisher: null },
      { ...source, tool: { name: 'other', version: '0.4.0' } },
    ];
    for (const value of invalid) expect(() => parseMediaSourceMetadata(value)).toThrow();
    expect(() => createMediaSourceMetadata(record, { index: 1, type: 'photo' }, '0.4.0')).toThrow();
    const iStatus: MediaSourceMetadata = { ...source, tweetUrl: 'https://x.com/i/status/12345' };
    expect(parseMediaSourceMetadata(iStatus)).toEqual(iStatus);
  });
});
