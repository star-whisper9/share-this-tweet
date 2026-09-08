import { expect, it } from 'vitest';
import { translationResponse, translationRequest } from '../src/page/translation-response.js';
import { TweetSource } from '../src/content/tweet-source.js';
const candidate = (id = '42', text = 'おはよう') => ({
  __typename: 'Tweet',
  rest_id: id,
  legacy: { full_text: text, lang: 'ja' },
});
const event = (requestId: number, phase: string, tweetId = '42', text?: string) => ({
  requestId,
  phase,
  tweetId,
  targetLanguage: 'zh',
  text,
});
it('parses adjacent JSON chunks with braces and escaped quotes in the text', () => {
  const fragments = ['a {', '"b"', '}'];
  expect(
    translationResponse(
      fragments.map((text) => JSON.stringify({ result: { content_type: 'POST', text } })).join(''),
    ),
  ).toBe(fragments.join(''));
  expect(() => translationResponse('{"result":')).toThrow();
  expect(
    translationRequest(
      'https://evil.example/2/grok/translation.json',
      '{"content_type":"POST","id":"42","dst_lang":"zh"}',
    ),
  ).toBeUndefined();
});
it('updates the exact tweet and its parent quote without reloading, retaining the original', () => {
  const source = new TweetSource();
  source.ingest([
    { ...candidate('1'), quoted_status_result: { result: candidate() } },
    candidate('99'),
  ]);
  source.ingestTranslation(event(1, 'start'));
  const updates: string[] = [];
  source.subscribe((record) => updates.push(record.tweetId));
  source.ingestTranslation(event(1, 'complete', '42', '早上好'));
  expect(source.get('1')?.quote?.record?.translation).toMatchObject({
    status: 'available',
    text: '早上好',
    originalText: 'おはよう',
  });
  expect(source.get('99')?.translation).toBeUndefined();
  expect(updates).toContain('1');
});
it('ignores superseded responses and prevents stale full records from clearing manual results', () => {
  const source = new TweetSource();
  source.ingest(candidate());
  source.ingestTranslation(event(1, 'start'));
  source.ingestTranslation(event(2, 'start'));
  source.ingestTranslation(event(2, 'complete', '42', 'new'));
  source.ingestTranslation(event(1, 'complete', '42', 'old'));
  source.ingest({
    ...candidate(),
    grok_translated_post_with_availability: { is_available: false },
  });
  expect(source.get('42')?.translation).toMatchObject({ status: 'available', text: 'new' });
});
it('queues early translations and exposes malformed or stale results for UI warnings', () => {
  const source = new TweetSource();
  source.ingestTranslation(event(1, 'start'));
  source.ingestTranslation(event(1, 'complete', '42', 'early'));
  source.ingest(candidate());
  expect(source.get('42')?.translation).toMatchObject({ status: 'available', text: 'early' });
  source.ingestTranslation(event(2, 'start'));
  source.ingestTranslation(event(2, 'complete'));
  expect(source.get('42')?.translation).toMatchObject({ status: 'invalid', reason: 'malformed' });
  source.ingestTranslation(event(3, 'start'));
  source.ingest(candidate('42', 'changed'));
  source.ingestTranslation(event(3, 'complete', '42', 'outdated'));
  expect(source.get('42')?.translation).toMatchObject({ status: 'invalid', reason: 'stale' });
});
