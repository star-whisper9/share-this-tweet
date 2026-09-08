import { expect, it } from 'vitest';
import { normalizeTweetCandidate } from '../src/shared/tweet-normalizer.js';
import { mergeTweetRecords } from '../src/shared/model.js';
import { TweetSource } from '../src/content/tweet-source.js';
import { buildTweetText } from '../src/core/text-export.js';
import { renderTemplate, TemplateError } from '../src/core/template.js';
import { validateStorageArchive, StorageError } from '../src/core/storage.js';

const tweet = (id: string, handle: string) => ({
  __typename: 'Tweet',
  rest_id: id,
  legacy: {
    full_text: `body-${id}`,
    user_id_str: handle,
    extended_entities: {
      media: [{ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.jpg` }],
    },
  },
  core: {
    user_results: { result: { rest_id: handle, legacy: { screen_name: handle, name: handle } } },
  },
});

it('keeps authors and media separate and stops after exactly one quoted layer', () => {
  const inner = { ...tweet('2', 'quoted'), quoted_status_result: { result: tweet('3', 'deeper') } };
  const result = normalizeTweetCandidate({
    ...tweet('1', 'main'),
    quoted_status_result: { result: inner },
  })!;
  expect(result.author.handle).toBe('main');
  expect(result.media[0].index).toBe(1);
  expect(result.quote?.record?.author.handle).toBe('quoted');
  expect(result.quote?.record?.media[0].index).toBe(1);
  expect(result.quote?.record).not.toHaveProperty('quote');
  expect(result.quote?.record?.tweetId).toBe('2');
});

it('distinguishes missing quote data from explicit unavailability and ignores self-reference', () => {
  const main = tweet('1', 'main');
  const pending = normalizeTweetCandidate({
    ...main,
    legacy: { ...main.legacy, quoted_status_id_str: '2' },
  })!;
  expect(pending.quote?.status).toBe('pending');
  const unavailable = normalizeTweetCandidate({
    ...main,
    legacy: { ...main.legacy, quoted_status_id_str: '2' },
    quoted_status_result: { result: { __typename: 'TweetTombstone' } },
  })!;
  expect(unavailable.quote?.status).toBe('unavailable');
  const self = normalizeTweetCandidate({ ...main, quoted_status_result: { result: main } })!;
  expect(self.quote).toBeUndefined();
  const available = normalizeTweetCandidate({
    ...main,
    quoted_status_result: { result: tweet('2', 'quoted') },
  })!;
  expect(mergeTweetRecords(available, pending).quote?.record?.author.handle).toBe('quoted');
});

it('hydrates a reference regardless of arrival order and notifies the parent after late data', () => {
  const main = tweet('1', 'main');
  const parent = { ...main, legacy: { ...main.legacy, quoted_status_id_str: '2' } };
  for (const incoming of [
    [parent, tweet('2', 'quoted')],
    [tweet('2', 'quoted'), parent],
  ]) {
    const source = new TweetSource();
    const updated: string[] = [];
    source.subscribe((record) => updated.push(record.tweetId));
    for (const record of incoming) source.ingest(record);
    expect(source.get('1')?.quote?.record?.author.handle).toBe('quoted');
    expect(updated).toContain('1');
  }
});

it('copies one quote by default and lets explicit quote variables control custom output', () => {
  const record = normalizeTweetCandidate({
    ...tweet('1', 'main'),
    quoted_status_result: { result: tweet('2', 'quoted') },
  })!;
  const copied = buildTweetText(record);
  expect(copied).toContain(record.text);
  expect(copied).toContain(record.quote!.record!.text);
  expect(copied).toContain(record.quote!.url);
  expect(buildTweetText(record, '{tweet.id}/{quote.tweet.id}/{quote.author.handle}')).toBe(
    '1/2/quoted',
  );
  expect(
    renderTemplate('{quote.tweet.text}', { tweet: normalizeTweetCandidate(tweet('4', 'alone'))! }),
  ).toBe('');
  expect(() => renderTemplate('{quote.unknown}', { tweet: record })).toThrow(TemplateError);
});

it('round-trips quoted snapshots and rejects nested or mismatched archive references', () => {
  const record = normalizeTweetCandidate({
    ...tweet('1', 'main'),
    quoted_status_result: { result: tweet('2', 'quoted') },
  })!;
  const archive = {
    schemaVersion: 1,
    exportedAt: '2026-09-08',
    tweetRecords: [{ ...record, savedAt: '2026-09-08' }],
    outputRecords: [],
  };
  expect(validateStorageArchive(JSON.parse(JSON.stringify(archive))).tweetRecords[0].quote).toEqual(
    record.quote,
  );
  const nested = structuredClone(archive);
  Object.assign(nested.tweetRecords[0].quote!.record!, { quote: record.quote });
  expect(() => validateStorageArchive(nested)).toThrow(StorageError);
  const mismatched = structuredClone(archive);
  mismatched.tweetRecords[0].quote!.tweetId = '99';
  expect(() => validateStorageArchive(mismatched)).toThrow(StorageError);
});
