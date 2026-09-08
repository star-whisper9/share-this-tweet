import { describe, expect, it } from 'vitest';
import { buildTweetText } from '../src/core/text-export.js';
import type { TweetRecord } from '../src/shared/model.js';

const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/alice/status/42',
  text: '第一行\n第二行',
  author: { id: '7', handle: '@alice', name: 'Alice' },
  media: [],
};

describe('buildTweetText', () => {
  it('keeps the body line breaks and includes source metadata', () => {
    const text = buildTweetText(record);
    for (const value of [record.text, record.author.handle, record.url, record.tweetId]) {
      expect(text).toContain(value);
    }
  });
});
