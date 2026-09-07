import { describe, expect, it } from 'vitest';
import { buildTweetText, DEFAULT_TEXT_TEMPLATE } from '../src/core/text-export.js';
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
    expect(buildTweetText(record)).toBe(
      '第一行\n第二行\n\n── @alice\nhttps://x.com/alice/status/42\nTweet ID: 42',
    );
  });

  it('supports a custom template through the shared template parser', () => {
    expect(buildTweetText(record, '{author.name}: {tweet.text}')).toBe('Alice: 第一行\n第二行');
    expect(DEFAULT_TEXT_TEMPLATE).toContain('{tweet.url}');
  });
});
