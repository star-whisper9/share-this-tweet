import { describe, expect, it } from 'vitest';
import { normalizeTweetCandidate } from '../src/shared/tweet-normalizer.js';

describe('normalizeTweetCandidate', () => {
  it('normalizes a GraphQL tweet with photo and video media', () => {
    const record = normalizeTweetCandidate({
      __typename: 'Tweet',
      rest_id: '42',
      legacy: {
        full_text: 'hello from X',
        created_at: 'Mon Sep 07 10:00:00 +0000 2026',
        user_id_str: '7',
        extended_entities: {
          media: [
            { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/photo.jpg' },
            {
              type: 'video',
              video_info: {
                variants: [
                  {
                    content_type: 'video/mp4',
                    bitrate: 64000,
                    url: 'https://video.twimg.com/low.mp4',
                  },
                  {
                    content_type: 'video/mp4',
                    bitrate: 128000,
                    url: 'https://video.twimg.com/high.mp4',
                  },
                ],
              },
            },
          ],
        },
      },
      core: {
        user_results: {
          result: {
            rest_id: '7',
            legacy: {
              screen_name: 'alice',
              name: 'Alice',
              profile_image_url_https: 'https://pbs.twimg.com/profile_images/7_normal.jpg',
            },
          },
        },
      },
    });

    expect(record?.tweetId).toBe('42');
    expect(record?.url).toBe('https://x.com/alice/status/42');
    expect(record?.author.handle).toBe('alice');
    expect(record?.author.avatarUrl).toBe('https://pbs.twimg.com/profile_images/7_400x400.jpg');
    expect(record?.media[0].originalUrl).toBe(
      'https://pbs.twimg.com/media/photo.jpg?format=jpg&name=orig',
    );
    expect(record?.media[1].variants).toHaveLength(2);
    expect(record?.publishedAt).toBe('2026-09-07T10:00:00.000Z');
  });

  it('normalizes a legacy tweet and rejects unrelated objects', () => {
    const record = normalizeTweetCandidate({
      id_str: '99',
      full_text: 'legacy text',
      user: { id_str: '8', screen_name: '@bob', name: 'Bob' },
    });

    expect(record?.author.handle).toBe('@bob');
    expect(normalizeTweetCandidate({ __typename: 'User', rest_id: '8' })).toBeUndefined();
  });

  it('removes only the media entity short link from visible tweet text', () => {
    const record = normalizeTweetCandidate({
      __typename: 'Tweet',
      rest_id: '100',
      legacy: {
        full_text: 'caption https://t.co/media123 https://t.co/real-link',
        entities: {
          urls: [{ url: 'https://t.co/real-link', expanded_url: 'https://example.com' }],
          media: [
            {
              url: 'https://t.co/media123',
              media_url_https: 'https://pbs.twimg.com/media/photo.jpg',
              type: 'photo',
            },
          ],
        },
        extended_entities: {
          media: [
            {
              url: 'https://t.co/media123',
              media_url_https: 'https://pbs.twimg.com/media/photo.jpg',
              type: 'photo',
            },
          ],
        },
      },
      core: {
        user_results: {
          result: { rest_id: '8', legacy: { screen_name: 'alice', name: 'Alice' } },
        },
      },
    });

    expect(record?.text).toBe('caption https://t.co/real-link');
  });

  it('decodes HTML entities in tweet text exactly once', () => {
    const record = normalizeTweetCandidate({
      id_str: '101',
      full_text: 'memcpy() is declared in &lt;strings.h&gt; &amp; written as &amp;lt;',
      user: { id_str: '8', screen_name: 'alice', name: 'Alice' },
    });

    expect(record?.text).toBe('memcpy() is declared in <strings.h> & written as &lt;');
  });
});
