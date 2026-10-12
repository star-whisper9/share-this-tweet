import { describe, expect, it } from 'vitest';
import fixture from './fixtures/poll-tweet.json';
import { normalizeTweetCandidate } from '../src/shared/tweet-normalizer.js';
import { mergeTweetRecords } from '../src/shared/model.js';
import {
  pollPercentage,
  pollTotalVotes,
  pollResultsVisible,
  pollWarning,
} from '../src/shared/poll.js';
import { buildTweetText, LEGACY_TEXT_TEMPLATE } from '../src/core/text-export.js';
import { renderTemplate } from '../src/core/template.js';
import { validateStorageArchive } from '../src/core/storage.js';
import { isExportJobRequest } from '../src/shared/export-jobs.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { TweetSource } from '../src/content/tweet-source.js';

function candidate(bindings = fixture.card.legacy.binding_values) {
  return { ...fixture, card: { legacy: { ...fixture.card.legacy, binding_values: bindings } } };
}
const record = () => normalizeTweetCandidate(candidate())!;
const available = () => {
  const poll = record().poll!;
  if (poll.status !== 'available') throw new Error('Fixture poll is invalid');
  return poll;
};

describe('poll response normalization', () => {
  it('preserves real GraphQL poll counts, selection and associated translations', () => {
    const poll = available();
    expect(poll.options).toEqual([
      { index: 1, label: '5h limits, 2X week usage', votes: 79775 },
      { index: 2, label: 'no 5h limits, same usage', votes: 91040 },
      { index: 3, label: 'show result', votes: 69828 },
    ]);
    expect(poll.selectedChoice).toBe(2);
    expect(poll.countsAreFinal).toBe(true);
    expect(pollTotalVotes(poll)).toBe(240643);
    expect(poll.options.map((option) => pollPercentage(poll, option.index))).toEqual([
      33.2, 37.8, 29,
    ]);
    expect(poll.translation).toMatchObject({
      status: 'available',
      labels: fixture.grok_translated_post_with_availability.data.associated_data.poll_translations,
      originalLabels: poll.options.map((option) => option.label),
    });
    const legacy = normalizeTweetCandidate({
      id_str: '42',
      full_text: 'poll',
      user: { screen_name: 'a' },
      card: {
        ...fixture.card.legacy,
        binding_values: Object.fromEntries(
          fixture.card.legacy.binding_values.map((item) => [item.key, item.value]),
        ),
      },
    });
    expect(legacy?.poll).toMatchObject({ options: poll.options, selectedChoice: 2 });
  });

  it('keeps unanswered, selected and final results independent and never invents missing counts', () => {
    const poll = { ...available(), countsAreFinal: false, selectedChoice: undefined };
    expect(pollResultsVisible(poll)).toBe(false);
    expect(pollPercentage(poll, 1)).toBeUndefined();
    expect(pollResultsVisible({ ...poll, countsAreFinal: true })).toBe(true);
    expect(pollResultsVisible({ ...poll, selectedChoice: 1 })).toBe(true);
    const missing = {
      ...poll,
      countsAreFinal: true,
      options: poll.options.map(({ votes: _votes, ...option }) => option),
    };
    expect(pollTotalVotes(missing)).toBeUndefined();
    expect(pollPercentage(missing, 1)).toBeUndefined();
    expect(
      pollPercentage(
        {
          ...poll,
          countsAreFinal: true,
          options: poll.options.map((option) => ({ ...option, votes: 0 })),
        },
        1,
      ),
    ).toBe(0);
    const unanswered = normalizeTweetCandidate(
      candidate(
        fixture.card.legacy.binding_values.filter((item) => item.key !== 'selected_choice'),
      ),
    )!;
    expect(unanswered.poll).toMatchObject({ status: 'available', countsAreFinal: true });
    expect(unanswered.poll).not.toHaveProperty('selectedChoice');
  });

  it('rejects malformed recognized polls and leaves unrelated link cards alone', () => {
    for (const bindings of [
      fixture.card.legacy.binding_values.filter((item) => item.key !== 'choice2_label'),
      [...fixture.card.legacy.binding_values, fixture.card.legacy.binding_values[0]],
      fixture.card.legacy.binding_values.map((item) =>
        item.key === 'choice2_count'
          ? { ...item, value: { string_value: '-1', type: 'STRING' } }
          : item,
      ),
    ])
      expect(normalizeTweetCandidate(candidate(bindings))?.poll).toEqual({ status: 'invalid' });
    expect(
      normalizeTweetCandidate({
        ...fixture,
        card: { legacy: { name: 'summary', binding_values: [] } },
      })?.poll,
    ).toBeUndefined();
    const broken = { ...record(), poll: { status: 'invalid' as const } };
    expect(() => buildTweetText(broken, '{tweet.text}')).toThrow(Error);
    expect(pollWarning(broken.poll)).toBeDefined();
  });

  it('reports incomplete choice translations while retaining the original poll', () => {
    const parsed = normalizeTweetCandidate({
      ...candidate(),
      grok_translated_post_with_availability: {
        ...fixture.grok_translated_post_with_availability,
        data: {
          ...fixture.grok_translated_post_with_availability.data,
          associated_data: { poll_translations: ['only one'] },
        },
      },
    })!;
    expect(parsed.poll).toMatchObject({
      status: 'available',
      translation: { status: 'invalid', reason: 'malformed' },
    });
    expect(pollWarning(parsed.poll)).toBeDefined();
    expect(buildTweetText(parsed)).toContain(available().options[1].label);
    expect(buildTweetText(parsed)).not.toContain('only one');
  });
});

it('merges poll updates without losing them to responses that omit cards, including quotes', () => {
  const initial = record();
  const oldPoll = {
    ...available(),
    options: available().options.map((option) => ({ ...option, votes: 0 })),
    updatedAt: '2026-10-11T06:00:00.000Z',
    countsAreFinal: false,
    selectedChoice: undefined,
  };
  expect(
    mergeTweetRecords(initial, {
      ...initial,
      poll: undefined,
      observedAt: '2026-10-12T02:00:00.000Z',
    }).poll,
  ).toEqual(initial.poll);
  expect(
    mergeTweetRecords(initial, {
      ...initial,
      poll: oldPoll,
      observedAt: '2026-10-12T03:00:00.000Z',
    }).poll,
  ).toEqual(initial.poll);
  for (const countsAreFinal of [false, undefined]) {
    expect(
      mergeTweetRecords(initial, {
        ...initial,
        poll: { ...oldPoll, countsAreFinal, updatedAt: undefined },
        observedAt: '2026-10-12T03:00:00.000Z',
      }).poll,
    ).toEqual(initial.poll);
  }
  const edited = {
    ...available(),
    options: available().options.map((option) => ({ ...option, label: option.label + ' changed' })),
    translation: undefined,
    updatedAt: '2026-10-12T03:00:00.000Z',
  };
  expect(
    mergeTweetRecords(initial, { ...initial, poll: edited, observedAt: '2026-10-12T03:00:00.000Z' })
      .poll,
  ).toMatchObject({ translation: { status: 'invalid', reason: 'stale' } });
  const expanded = {
    ...edited,
    options: [...available().options, { index: 4, label: 'Another option', votes: 0 }],
  };
  expect(
    mergeTweetRecords(initial, {
      ...initial,
      poll: expanded,
      observedAt: '2026-10-12T03:00:00.000Z',
    }).poll,
  ).toMatchObject({ translation: { status: 'invalid', reason: 'stale' } });
  const source = new TweetSource();
  source.ingest({
    __typename: 'Tweet',
    rest_id: '1',
    legacy: { full_text: 'quote' },
    quoted_status_result: { result: candidate() },
  });
  expect(source.get('1')?.quote?.record?.poll).toEqual(initial.poll);
});

it('exports translated and original options once in order and supports custom and quoted templates', () => {
  const tweet = record();
  const poll = available();
  const labels =
    fixture.grok_translated_post_with_availability.data.associated_data.poll_translations;
  for (const template of [undefined, LEGACY_TEXT_TEMPLATE]) {
    const text = buildTweetText(tweet, template);
    expect(text.indexOf(labels[0])).toBeGreaterThan(
      text.indexOf(tweet.translation!.status === 'available' ? tweet.translation.text : ''),
    );
    expect(text.indexOf(poll.options[0].label)).toBeGreaterThan(text.indexOf(tweet.text));
    expect(text).toContain('37.8%');
    expect(text.split(poll.options[1].label)).toHaveLength(2);
    expect(text.split(labels[1])).toHaveLength(2);
  }
  const custom = buildTweetText(tweet, '{tweet.text}\n{author.name}');
  expect(custom).toContain(poll.options[2].label);
  const explicit = buildTweetText(tweet, '{poll.originalText}');
  expect(explicit.split(poll.options[0].label)).toHaveLength(2);
  expect(
    renderTemplate('{?poll.translatedText}{poll.translatedText}{/poll.translatedText}', {
      tweet: { ...tweet, translation: undefined },
    }),
  ).toBe('');
  const quoted = {
    ...tweet,
    tweetId: '99',
    text: 'parent',
    poll: undefined,
    translation: undefined,
    quote: { status: 'available' as const, tweetId: tweet.tweetId, record: tweet },
  };
  expect(buildTweetText(quoted)).toContain(poll.options[0].label);
});

it('validates poll snapshots and archives while retaining compatibility with older records', () => {
  const tweet = record();
  const archive = (value: unknown) => ({
    schemaVersion: 1,
    exportedAt: '2026-10-12',
    tweetRecords: [{ ...tweet, poll: value, savedAt: '2026-10-12' }],
    outputRecords: [],
  });
  for (const poll of [undefined, tweet.poll])
    expect(() => validateStorageArchive(archive(poll))).not.toThrow();
  const job = {
    id: 'poll',
    kind: 'card',
    locale: 'en',
    theme: 'light',
    settings: DEFAULT_SETTINGS,
    record: tweet,
    media: [],
  };
  expect(isExportJobRequest(job)).toBe(true);
  for (const poll of [
    { ...available(), selectedChoice: 5 },
    {
      ...available(),
      options: available().options.map((option) => ({ ...option, votes: Infinity })),
    },
    {
      ...available(),
      translation: { status: 'available', labels: ['one'], originalLabels: ['wrong'] },
    },
  ]) {
    expect(() => validateStorageArchive(archive(poll))).toThrow(Error);
    expect(isExportJobRequest({ ...job, record: { ...tweet, poll } })).toBe(false);
  }
});

it('does not pair a new manual translation language with old translated choices', () => {
  const source = new TweetSource();
  source.ingest(candidate());
  source.ingestTranslation({
    requestId: 1,
    phase: 'start',
    tweetId: fixture.rest_id,
    targetLanguage: 'ja',
  });
  source.ingestTranslation({
    requestId: 1,
    phase: 'complete',
    tweetId: fixture.rest_id,
    targetLanguage: 'ja',
    text: '新しい翻訳',
  });
  const updated = source.get(fixture.rest_id)!;
  expect(updated.translation).toMatchObject({ status: 'available', targetLanguage: 'ja' });
  expect(updated.poll).toMatchObject({ translation: { status: 'invalid', reason: 'stale' } });
  const text = buildTweetText(updated);
  expect(text).toContain('新しい翻訳');
  expect(text).toContain(available().options[0].label);
  expect(text).not.toContain(
    fixture.grok_translated_post_with_availability.data.associated_data.poll_translations[0],
  );
});
