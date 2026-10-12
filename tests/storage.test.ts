import { describe, expect, it } from 'vitest';
import { createOutputRecord, validateStorageArchive, StorageError } from '../src/core/storage.js';

describe('storage record models', () => {
  it('creates an output record without changing the supplied output metadata', () => {
    const output = createOutputRecord(
      {
        tweetId: '42',
        outputType: 'framed-image',
        filename: 'photo_framed.png',
        mediaIndex: 1,
      },
      'output-1',
      '2026-09-07T10:00:00.000Z',
    );

    expect(output).toEqual({
      id: 'output-1',
      tweetId: '42',
      outputType: 'framed-image',
      filename: 'photo_framed.png',
      mediaIndex: 1,
      createdAt: '2026-09-07T10:00:00.000Z',
    });
  });

  it('rejects archives with unsupported output types', () => {
    expect(() =>
      validateStorageArchive({
        schemaVersion: 1,
        exportedAt: '2026-09-07T10:00:00.000Z',
        tweetRecords: [],
        outputRecords: [
          {
            id: 'output-1',
            tweetId: '42',
            outputType: 'unknown',
            createdAt: '2026-09-07T10:00:00.000Z',
          },
        ],
      }),
    ).toThrow(StorageError);
  });

  it('accepts older archives and rejects malformed base record fields', () => {
    const record = {
      tweetId: '42',
      url: 'https://x.com/a/status/42',
      text: '',
      author: { id: '', handle: 'a', name: '' },
      media: [{ index: 1, type: 'photo', originalUrl: 'https://pbs.twimg.com/a.jpg' }],
      savedAt: '2026-09-07',
    };
    const archive = {
      schemaVersion: 1,
      exportedAt: '2026-09-07',
      tweetRecords: [record],
      outputRecords: [createOutputRecord({ tweetId: '42', outputType: 'sourced-media' })],
    };
    expect(validateStorageArchive(archive).tweetRecords).toEqual([record]);
    for (const patch of [
      { author: { ...record.author, handle: 123 } },
      { author: {} },
      { media: [{}] },
      { media: [{ ...record.media[0], variants: [{ url: 123, mime: 'video/mp4' }] }] },
      { savedAt: 'not a date' },
    ]) {
      expect(() =>
        validateStorageArchive({ ...archive, tweetRecords: [{ ...record, ...patch }] }),
      ).toThrow(StorageError);
    }
  });
});
