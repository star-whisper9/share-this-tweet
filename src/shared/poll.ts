import { decodeHtmlEntities } from './html-entities.js';
import type { TweetTranslation } from './translation.js';
import { getLocale, t, type Locale } from './i18n.js';

export interface PollOption {
  index: number;
  label: string;
  votes?: number;
}
export interface AvailableTweetPoll {
  status: 'available';
  options: PollOption[];
  selectedChoice?: number;
  countsAreFinal?: boolean;
  endsAt?: string;
  updatedAt?: string;
  translation?:
    | { status: 'available'; labels: string[]; originalLabels: string[]; targetLanguage?: string }
    | { status: 'invalid'; reason: 'malformed' | 'stale' };
}
export type TweetPoll = AvailableTweetPoll | { status: 'invalid' };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : undefined;
const label = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 10000;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));

/** Preserve recognized malformed polls as an explicit export error. Other cards are not polls. */
export function normalizePoll(value: unknown, translatedPost?: unknown): TweetPoll | undefined {
  const input = object(value);
  const card = object(input?.legacy) ?? input;
  if (!card || typeof card.name !== 'string' || !card.name.startsWith('poll')) return undefined;
  const size = /^poll([2-4])choice_(?:text_only|image|video)$/.exec(card.name)?.[1];
  if (!size) return { status: 'invalid' };
  const raw = card.binding_values;
  const values = new Map<string, ObjectValue>();
  if (Array.isArray(raw)) {
    if (raw.length > 100) return { status: 'invalid' };
    for (const entry of raw) {
      const item = object(entry);
      const data = object(item?.value);
      if (!item || typeof item.key !== 'string' || !data || values.has(item.key))
        return { status: 'invalid' };
      values.set(item.key, data);
    }
  } else {
    const bindings = object(raw);
    if (!bindings || Object.keys(bindings).length > 100) return { status: 'invalid' };
    for (const [key, value] of Object.entries(bindings)) {
      const data = object(value);
      if (!data) return { status: 'invalid' };
      values.set(key, data);
    }
  }
  const text = (key: string) => values.get(key)?.string_value;
  const options: PollOption[] = [];
  for (let index = 1; index <= Number(size); index++) {
    const rawLabel = text(`choice${index}_label`);
    const rawVotes = text(`choice${index}_count`);
    if (!label(rawLabel)) return { status: 'invalid' };
    const decoded = decodeHtmlEntities(rawLabel).trim();
    if (!decoded) return { status: 'invalid' };
    let votes: number | undefined;
    if (values.has(`choice${index}_count`)) {
      if (typeof rawVotes !== 'string' || !/^\d+$/.test(rawVotes) || !count(Number(rawVotes)))
        return { status: 'invalid' };
      votes = Number(rawVotes);
    }
    options.push({ index, label: decoded, ...(votes !== undefined ? { votes } : {}) });
  }
  const selected = text('selected_choice');
  // Some responses encode an unanswered poll as an empty string or zero.
  const selectedChoice = selected === '' || selected === '0' ? undefined : Number(selected);
  if (
    values.has('selected_choice') &&
    selectedChoice !== undefined &&
    (typeof selected !== 'string' || !/^[1-4]$/.test(selected) || selectedChoice > options.length)
  )
    return { status: 'invalid' };
  const final = values.get('counts_are_final')?.boolean_value;
  if (values.has('counts_are_final') && typeof final !== 'boolean') return { status: 'invalid' };
  for (const key of ['end_datetime_utc', 'last_updated_datetime_utc'])
    if (values.has(key) && !date(text(key))) return { status: 'invalid' };
  const poll: AvailableTweetPoll = {
    status: 'available',
    options,
    ...(values.has('selected_choice') && selectedChoice !== undefined ? { selectedChoice } : {}),
    ...(typeof final === 'boolean' ? { countsAreFinal: final } : {}),
    ...(date(text('end_datetime_utc'))
      ? { endsAt: new Date(text('end_datetime_utc') as string).toISOString() }
      : {}),
    ...(date(text('last_updated_datetime_utc'))
      ? { updatedAt: new Date(text('last_updated_datetime_utc') as string).toISOString() }
      : {}),
  };
  if (
    options.every((option) => option.votes !== undefined) &&
    !count(options.reduce((sum, option) => sum + option.votes!, 0))
  )
    return { status: 'invalid' };
  const translated = object(translatedPost);
  const data = object(translated?.data);
  const labels = object(data?.associated_data)?.poll_translations;
  if (translated?.is_available === true && labels !== undefined) {
    if (!Array.isArray(labels) || labels.length !== options.length || !labels.every(label))
      poll.translation = { status: 'invalid', reason: 'malformed' };
    else {
      const decoded = labels.map((value) => decodeHtmlEntities(value).trim());
      poll.translation = decoded.every(label)
        ? {
            status: 'available',
            labels: decoded,
            originalLabels: options.map((option) => option.label),
            ...(typeof data?.destination_language === 'string' &&
            data.destination_language.length <= 100
              ? { targetLanguage: data.destination_language }
              : {}),
          }
        : { status: 'invalid', reason: 'malformed' };
    }
  }
  return poll;
}

export function pollResultsVisible(poll: AvailableTweetPoll): boolean {
  return poll.countsAreFinal === true || poll.selectedChoice !== undefined;
}
export function pollTotalVotes(poll: AvailableTweetPoll): number | undefined {
  return poll.options.every((option) => option.votes !== undefined)
    ? poll.options.reduce((sum, option) => sum + option.votes!, 0)
    : undefined;
}
export function pollPercentage(poll: AvailableTweetPoll, index: number): number | undefined {
  const total = pollTotalVotes(poll);
  const votes = poll.options.find((option) => option.index === index)?.votes;
  if (!pollResultsVisible(poll) || total === undefined || votes === undefined) return undefined;
  return total === 0 ? 0 : Math.round((votes / total) * 1000) / 10;
}
export function pollLabels(poll: AvailableTweetPoll, translated = false): string[] {
  return translated && poll.translation?.status === 'available'
    ? poll.translation.labels
    : poll.options.map((option) => option.label);
}
export function pollFooter(poll: AvailableTweetPoll, locale: Locale = getLocale()): string {
  const total = pollTotalVotes(poll);
  return [
    total === undefined
      ? undefined
      : t('core.poll.votes', { count: new Intl.NumberFormat(locale).format(total) }, locale),
    poll.countsAreFinal === true
      ? t('core.poll.final', {}, locale)
      : poll.endsAt
        ? t(
            'core.poll.endsAt',
            {
              date: new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(poll.endsAt)),
            },
            locale,
          )
        : t('core.poll.open', {}, locale),
  ]
    .filter(Boolean)
    .join(' · ');
}
export function buildPollText(
  poll?: TweetPoll,
  translated = false,
  locale: Locale = getLocale(),
): string | undefined {
  if (!poll) return undefined;
  if (poll.status === 'invalid') throw new Error(t('core.poll.invalid', {}, locale));
  if (translated && poll.translation?.status !== 'available') return undefined;
  const labels = pollLabels(poll, translated);
  return [
    ...poll.options.map((option, offset) => {
      const percentage = pollPercentage(poll, option.index);
      return `${option.index}. ${labels[offset]}${option.index === poll.selectedChoice ? ' ✓' : ''}${percentage === undefined ? '' : ` — ${percentage}%`}`;
    }),
    pollFooter(poll, locale),
  ].join('\n');
}
export function pollWarning(poll?: TweetPoll, locale: Locale = getLocale()): string | undefined {
  if (poll?.status === 'invalid') return t('core.poll.invalid', {}, locale);
  if (poll?.translation?.status === 'invalid') return t('core.poll.translationInvalid', {}, locale);
  return undefined;
}

export function mergePoll(preferred?: TweetPoll, fallback?: TweetPoll): TweetPoll | undefined {
  if (!preferred) return fallback;
  if (preferred.status !== 'available' || fallback?.status !== 'available') return preferred;
  const sameOptions =
    preferred.options.length === fallback.options.length &&
    preferred.options.every((option, offset) => option.label === fallback.options[offset].label);
  // The server update timestamp prevents older timeline snapshots from undoing a vote/result.
  // Final results cannot return to an ongoing state, even when an update omits its timestamp.
  const poll =
    (sameOptions && fallback.countsAreFinal === true && preferred.countsAreFinal !== true) ||
    (preferred.updatedAt && fallback.updatedAt && preferred.updatedAt < fallback.updatedAt)
      ? fallback
      : preferred;
  const other = poll === preferred ? fallback : preferred;
  const translation = poll.translation ?? other.translation;
  return {
    ...poll,
    ...(sameOptions && poll.selectedChoice === undefined && other.selectedChoice !== undefined
      ? { selectedChoice: other.selectedChoice }
      : {}),
    ...(translation
      ? {
          translation:
            translation.status === 'available' &&
            (translation.labels.length !== poll.options.length ||
              translation.originalLabels.length !== poll.options.length ||
              !translation.originalLabels.every(
                (value, offset) => value === poll.options[offset]?.label,
              ))
              ? { status: 'invalid', reason: 'stale' }
              : translation,
        }
      : {}),
  };
}

/** A later manual body translation must not reuse choices translated into another language. */
export function bindPollTranslation(
  poll: TweetPoll | undefined,
  translation?: TweetTranslation,
): TweetPoll | undefined {
  if (
    poll?.status !== 'available' ||
    poll.translation?.status !== 'available' ||
    translation?.status !== 'available'
  )
    return poll;
  const target = poll.translation.targetLanguage?.toLowerCase().replace(/_/g, '-');
  const bodyTarget = translation.targetLanguage?.toLowerCase().replace(/_/g, '-');
  return target && bodyTarget && target !== bodyTarget
    ? { ...poll, translation: { status: 'invalid', reason: 'stale' } }
    : poll;
}

export function validPoll(value: unknown): boolean {
  if (value === undefined) return true;
  const poll = object(value);
  if (!poll) return false;
  if (poll.status === 'invalid') return true;
  if (
    poll.status !== 'available' ||
    !Array.isArray(poll.options) ||
    poll.options.length < 2 ||
    poll.options.length > 4
  )
    return false;
  if (
    !poll.options.every((value, offset) => {
      const option = object(value);
      return (
        option?.index === offset + 1 &&
        label(option.label) &&
        (option.votes === undefined || count(option.votes))
      );
    })
  )
    return false;
  if (
    poll.selectedChoice !== undefined &&
    (!Number.isInteger(poll.selectedChoice) ||
      Number(poll.selectedChoice) < 1 ||
      Number(poll.selectedChoice) > poll.options.length)
  )
    return false;
  if (poll.countsAreFinal !== undefined && typeof poll.countsAreFinal !== 'boolean') return false;
  if (['endsAt', 'updatedAt'].some((key) => poll[key] !== undefined && !date(poll[key])))
    return false;
  if (!count((poll.options as PollOption[]).reduce((sum, option) => sum + (option.votes ?? 0), 0)))
    return false;
  if (poll.translation === undefined) return true;
  const translation = object(poll.translation);
  if (!translation) return false;
  if (translation.status === 'invalid')
    return ['malformed', 'stale'].includes(String(translation.reason));
  return (
    translation.status === 'available' &&
    Array.isArray(translation.labels) &&
    translation.labels.length === poll.options.length &&
    translation.labels.every(label) &&
    Array.isArray(translation.originalLabels) &&
    translation.originalLabels.length === poll.options.length &&
    translation.originalLabels.every(
      (value, offset) => value === (poll.options as PollOption[])[offset].label,
    ) &&
    (translation.targetLanguage === undefined ||
      (typeof translation.targetLanguage === 'string' && translation.targetLanguage.length <= 100))
  );
}
