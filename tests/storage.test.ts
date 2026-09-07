import { describe, expect, it } from 'vitest';
import { createOutputRecord } from '../src/core/storage.js';

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
});
