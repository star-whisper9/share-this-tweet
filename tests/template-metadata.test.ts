import { validateStorageArchive, StorageError } from '../src/core/storage.js';
import { expect, it } from 'vitest';
import { TEMPLATE_FIELDS, renderTemplate, TemplateError } from '../src/core/template.js';
import { mergeTweetRecords, type TweetRecord } from '../src/shared/model.js';
import { normalizeTweetCandidate } from '../src/shared/tweet-normalizer.js';
const tweet: TweetRecord = {
  tweetId: '1',
  url: 'https://x.com/a/status/1',
  text: 'body',
  author: { id: '2', name: 'a', handle: 'a' },
  media: [],
};

it('resolves every registered field with valid empty optional contexts', () => {
  expect(new Set(TEMPLATE_FIELDS.map((field) => field.name)).size).toBe(TEMPLATE_FIELDS.length);
  for (const field of TEMPLATE_FIELDS) {
    expect(() =>
      renderTemplate(`{${field.name}}`, { tweet, media: { index: 1, type: 'photo' } }),
    ).not.toThrow();
  }
});
it('preserves zero and false, handles missing dates and validates hidden branches', () => {
  expect(
    renderTemplate('{tweet.mediaCount}/{tweet.sensitive}/{tweet.publishedAt:YYYY-MM-DD|unknown}', {
      tweet: { ...tweet, sensitive: false },
    }),
  ).toBe('0/false/unknown');
  expect(renderTemplate('A{?quote.tweet.id}B{quote.tweet.text}{/quote.tweet.id}C', { tweet })).toBe(
    'AC',
  );
  expect(() => renderTemplate('{?quote.tweet.id}{invalid}{/quote.tweet.id}', { tweet })).toThrow(
    TemplateError,
  );
  expect(() => renderTemplate('{?tweet.id}x', { tweet })).toThrow(TemplateError);
  expect(() =>
    renderTemplate('{?tweet.id}{?tweet.text}x{/tweet.text}{/tweet.id}', { tweet }),
  ).toThrow(TemplateError);
});
it('prefers complete text over partial data, but permits a later shorter complete revision', () => {
  const original = {
    ...tweet,
    text: 'long complete body',
    textSource: 'full' as const,
    observedAt: '2026-09-08T01:00:00.000Z',
    language: 'en',
  };
  const partial = {
    ...tweet,
    text: 'long',
    textSource: 'partial' as const,
    observedAt: '2026-09-08T02:00:00.000Z',
  };
  expect(mergeTweetRecords(original, partial).text).toBe(original.text);
  expect(mergeTweetRecords(original, partial).language).toBe('en');
  const edited = { ...partial, text: 'short', textSource: 'full' as const };
  expect(mergeTweetRecords(original, edited).text).toBe('short');
  expect(() =>
    mergeTweetRecords(original, { ...edited, author: { ...tweet.author, id: '3' } }),
  ).toThrow();
});
it('reads optional metadata without coercing malformed fields into values', () => {
  const record = normalizeTweetCandidate({
    __typename: 'Tweet',
    rest_id: '1',
    legacy: {
      full_text: 'body',
      lang: 'en',
      possibly_sensitive: false,
      in_reply_to_status_id_str: '9',
      extended_entities: {
        media: [
          {
            type: 'video',
            ext_alt_text: 'caption',
            video_info: { duration_millis: 0, variants: [] },
          },
        ],
      },
    },
    core: {
      user_results: {
        result: {
          rest_id: '2',
          legacy: { name: 'a', screen_name: 'a', description: 'bio', url: 'javascript:alert(1)' },
        },
      },
    },
  })!;
  expect(record.sensitive).toBe(false);
  expect(record.replyToTweetId).toBe('9');
  expect(record.media[0].durationMs).toBe(0);
  expect(record.media[0].altText).toBe('caption');
  expect(record.author.url).toBeUndefined();
});

it('validates imported optional metadata while accepting older archives', () => {
  const archive = {
    schemaVersion: 1,
    exportedAt: '2026-09-08',
    tweetRecords: [{ ...tweet, savedAt: '2026-09-08' }],
    outputRecords: [],
  };
  expect(() => validateStorageArchive(archive)).not.toThrow();
  expect(() =>
    validateStorageArchive({
      ...archive,
      tweetRecords: [{ ...archive.tweetRecords[0], sensitive: 'false' }],
    }),
  ).toThrow(StorageError);
  expect(() =>
    validateStorageArchive({
      ...archive,
      tweetRecords: [{ ...archive.tweetRecords[0], editIds: [{}] }],
    }),
  ).toThrow(StorageError);
  expect(() =>
    validateStorageArchive({
      ...archive,
      tweetRecords: [
        {
          ...archive.tweetRecords[0],
          media: [
            {
              index: 1,
              type: 'video',
              previewUrl: 'https://pbs.twimg.com/media/preview.jpg',
            },
          ],
        },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    validateStorageArchive({
      ...archive,
      tweetRecords: [
        {
          ...archive.tweetRecords[0],
          media: [{ index: 1, type: 'video', previewUrl: 'https://example.com/preview.jpg' }],
        },
      ],
    }),
  ).toThrow(StorageError);
});
