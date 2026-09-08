import { expect, it } from 'vitest';
import {
  normalizeTranslation,
  languageName,
  translationWarning,
  mergeTranslation,
} from '../src/shared/translation.js';
import { mergeTweetRecords, type TweetRecord } from '../src/shared/model.js';
import { calculateTweetCardLayout } from '../src/core/card.js';
import { buildTweetText } from '../src/core/text-export.js';
import { renderTemplate } from '../src/core/template.js';
import { normalizeTweetCandidate } from '../src/shared/tweet-normalizer.js';

const payload = {
  is_available: true,
  data: { source_language: 'en', destination_language: 'zh', translation: '今天的照片。' },
};
const record: TweetRecord = {
  tweetId: '1',
  url: 'https://x.com/a/status/1',
  text: 'A photo from today.',
  language: 'en',
  author: { id: '2', name: 'Alice', handle: 'a' },
  media: [],
};

it('accepts native embedded translations without replacing the original text', () => {
  const parsed = normalizeTweetCandidate({
    __typename: 'Tweet',
    rest_id: '1',
    legacy: { full_text: record.text, lang: 'en' },
    grok_translated_post_with_availability: payload,
  })!;
  expect(parsed.text).toBe(record.text);
  expect(parsed.translation?.status).toBe('available');
  expect(parsed.translation).toMatchObject({
    text: payload.data.translation,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    originalText: record.text,
  });
});
it('warns only on unexpected data, keeping ordinary unavailable translations silent', () => {
  for (const data of [undefined, { is_available: false }])
    expect(translationWarning(normalizeTranslation(data, record.text))).toBeUndefined();
  const empty = normalizeTranslation(
    { ...payload, data: { ...payload.data, translation: '  ' } },
    record.text,
  );
  expect(empty).toEqual({ status: 'invalid', reason: 'empty' });
  expect(translationWarning(empty)).toBeDefined();
  expect(normalizeTranslation({ is_available: true }, record.text)).toEqual({
    status: 'invalid',
    reason: 'malformed',
  });
});
it('uses provided readable names first and only maps known language codes', () => {
  expect(languageName('en', 'English')).toBe('English');
  expect(languageName('en')).toBe('英语');
  expect(languageName('ja', undefined, 'en')).toBe('Japanese');
  expect(languageName('unmapped-XYZ')).toBe('unmapped-XYZ');
});
it('invalidates stale translations instead of pairing them with changed originals', () => {
  const translation = normalizeTranslation(payload, record.text)!;
  expect(mergeTranslation(undefined, translation, record.text)).toEqual(translation);
  expect(mergeTranslation(undefined, translation, 'changed')).toEqual({
    status: 'invalid',
    reason: 'stale',
  });
  const merged = mergeTweetRecords(
    { ...record, translation },
    { ...record, text: 'changed', observedAt: '2026-09-08T01:00:00.000Z' },
  );
  expect(merged.text).toBe('changed');
  expect(merged.translation?.status).toBe('invalid');
});
it('provides four independent template fields and optional bilingual presets', () => {
  const translated = { ...record, translation: normalizeTranslation(payload, record.text) };
  expect(
    renderTemplate(
      '{translation.sourceLanguage}/{translation.targetLanguage}/{translation.originalText}/{translation.text}',
      { tweet: translated },
    ),
  ).toBe(`英语/中文/${record.text}/${payload.data.translation}`);
  expect(buildTweetText(translated)).toContain(payload.data.translation);
  expect(buildTweetText(translated)).toContain(record.text);
  expect(
    renderTemplate(
      '{?translation.text}{translation.text}\n{/translation.text}{translation.originalText}',
      { tweet: record },
    ),
  ).toBe(record.text);
  const quoted = {
    ...record,
    quote: { status: 'available' as const, tweetId: '3', record: { ...translated, tweetId: '3' } },
  };
  expect(renderTemplate('{quote.translation.text}', { tweet: quoted })).toBe(
    payload.data.translation,
  );
});
it('lays out the complete bilingual body in order and leaves original-only cards unchanged', () => {
  const measureText = (text: string) => ({ width: text.length * 8 });
  const original = calculateTweetCardLayout({ text: record.text, images: [], measureText });
  const bilingual = calculateTweetCardLayout({
    text: record.text,
    translation: { text: payload.data.translation, sourceLanguage: '英语' },
    images: [],
    measureText,
  });
  expect(bilingual.bodyLines.filter((line) => line.icon).map((line) => line.icon)).toEqual([
    'grok',
    'x',
  ]);
  const lines = bilingual.textLines;
  expect(lines.indexOf(payload.data.translation)).toBeLessThan(lines.indexOf(record.text));
  expect(bilingual.height).toBeGreaterThan(original.height);
  expect(original.bodyLines.every((line) => !line.icon)).toBe(true);
});
