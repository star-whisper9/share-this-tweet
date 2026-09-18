import { languageName } from '../shared/translation.js';
import { t, type Locale, type MessageKey } from '../shared/i18n.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';

export interface TemplateContext {
  tweet: TweetRecord;
  media?: MediaRecord;
  extension?: string;
  card?: boolean;
  /** Render an avatar marker only in a frame, after optional sections are evaluated. */
  avatarMarker?: string;
  locale?: Locale;
}
export type TemplateScope = 'filenameTemplate' | 'frameTemplate' | 'textTemplate';
export interface TemplateField {
  name: string;
  label: string;
  group: '推文' | '作者' | '媒体' | '引用' | '输出';
  example: string;
  description: string;
  date?: boolean;
  media?: boolean;
  read: (context: TemplateContext) => string | number | boolean | undefined;
}
const field = (
  name: string,
  group: TemplateField['group'],
  example: string | { key: MessageKey },
  read: TemplateField['read'],
  options: Partial<Pick<TemplateField, 'date' | 'media'>> = {},
): TemplateField => {
  return {
    name,
    get label() {
      return t(`core.field.label.${name}` as MessageKey);
    },
    group,
    get example() {
      return typeof example === 'string' ? example : t(example.key);
    },
    read,
    get description() {
      return t(`core.field.description.${name}` as MessageKey);
    },
    ...options,
  };
};
const base: TemplateField[] = [
  field('tweet.id', '推文', '1234567890', ({ tweet }) => tweet.tweetId),
  field('tweet.url', '推文', 'https://x.com/example/status/1234567890', ({ tweet }) => tweet.url),
  field('tweet.text', '推文', { key: 'core.field.example.tweet.text' }, ({ tweet }) => tweet.text),
  field('tweet.publishedAt', '推文', '2026-09-08T10:00:00.000Z', ({ tweet }) => tweet.publishedAt, {
    date: true,
  }),
  field(
    'translation.sourceLanguage',
    '推文',
    { key: 'core.field.example.translation.sourceLanguage' },
    ({ tweet, locale }) => {
      const t = tweet.translation;
      return languageName(
        t?.status === 'available' ? t.sourceLanguage : tweet.language,
        t?.status === 'available' ? t.sourceLanguageName : undefined,
        locale,
      );
    },
  ),
  field(
    'translation.targetLanguage',
    '推文',
    { key: 'core.field.example.translation.targetLanguage' },
    ({ tweet, locale }) => {
      const t = tweet.translation;
      return t?.status === 'available'
        ? languageName(t.targetLanguage, t.targetLanguageName, locale)
        : undefined;
    },
  ),
  field('translation.originalText', '推文', 'Hello', ({ tweet }) => tweet.text),
  field('translation.text', '推文', { key: 'core.field.example.translation.text' }, ({ tweet }) =>
    tweet.translation?.status === 'available' ? tweet.translation.text : undefined,
  ),
  field('tweet.language', '推文', 'zh', ({ tweet }) => tweet.language),
  field('tweet.replyToTweetId', '推文', '123456789', ({ tweet }) => tweet.replyToTweetId),
  field('tweet.replyToUserId', '推文', '12345', ({ tweet }) => tweet.replyToUserId),
  field('tweet.sensitive', '推文', 'false', ({ tweet }) => tweet.sensitive),
  field('tweet.editIds', '推文', '123, 456', ({ tweet }) => tweet.editIds?.join(', ')),
  field('tweet.mediaCount', '推文', '4', ({ tweet }) => tweet.media.length),
  field('tweet.observedAt', '推文', '2026-09-08T10:00:00.000Z', ({ tweet }) => tweet.observedAt, {
    date: true,
  }),
  field('author.id', '作者', '12345', ({ tweet }) => tweet.author.id),
  field('author.handle', '作者', 'example', ({ tweet }) => tweet.author.handle.replace(/^@+/, '')),
  field(
    'author.name',
    '作者',
    { key: 'core.field.example.author.name' },
    ({ tweet }) => tweet.author.name,
  ),
  field(
    'author.avatar',
    '作者',
    'https://pbs.twimg.com/profile_images/example.png',
    ({ tweet }) => tweet.author.avatarUrl,
  ),
  field(
    'author.description',
    '作者',
    { key: 'core.field.example.author.description' },
    ({ tweet }) => tweet.author.description,
  ),
  field('author.location', '作者', 'Shanghai', ({ tweet }) => tweet.author.location),
  field('author.url', '作者', 'https://example.com/', ({ tweet }) => tweet.author.url),
  field(
    'author.createdAt',
    '作者',
    '2020-01-01T00:00:00.000Z',
    ({ tweet }) => tweet.author.createdAt,
    { date: true },
  ),
  field('media.index', '媒体', '1', ({ media, card }) => media?.index ?? (card ? 0 : undefined), {
    media: true,
  }),
  field('media.type', '媒体', 'photo', ({ media }) => media?.type, { media: true }),
  field(
    'media.url',
    '媒体',
    'https://pbs.twimg.com/media/example.jpg',
    ({ media }) => media?.originalUrl,
    { media: true },
  ),
  field('media.width', '媒体', '1200', ({ media }) => media?.width, { media: true }),
  field('media.height', '媒体', '800', ({ media }) => media?.height, { media: true }),
  field(
    'media.altText',
    '媒体',
    { key: 'core.field.example.media.altText' },
    ({ media }) => media?.altText,
    { media: true },
  ),
  field('media.durationMs', '媒体', '12500', ({ media }) => media?.durationMs, { media: true }),
  field('media.variantCount', '媒体', '3', ({ media }) => media?.variants?.length, { media: true }),
  field(
    'media.bitrate',
    '媒体',
    '2176000',
    ({ media }) => {
      const rates =
        media?.variants
          ?.filter((v) => v.mime === 'video/mp4' && v.bitrate !== undefined)
          .map((v) => v.bitrate!) ?? [];
      return rates.length ? Math.max(...rates) : undefined;
    },
    { media: true },
  ),
  field('extension', '输出', 'jpg', ({ extension }) => extension),
];
export const TEMPLATE_FIELDS: readonly TemplateField[] = [
  ...base,
  field('quote.status', '引用', 'available', ({ tweet }) => tweet.quote?.status),
  ...base
    .filter((item) => item.group === '推文' || item.group === '作者')
    .map((item): TemplateField => ({
      ...item,
      name: `quote.${item.name}`,
      get label() {
        return t('core.field.quotePrefix', { label: item.label });
      },
      group: '引用',
      get description() {
        return item.name === 'author.avatar'
          ? t('core.field.quoteAvatarDescription')
          : t('core.field.quoteDescription', { description: item.description });
      },
      read: (context) => {
        if (item.name === 'tweet.id') return context.tweet.quote?.tweetId;
        if (item.name === 'tweet.url') return context.tweet.quote?.url;
        const tweet = context.tweet.quote?.record;
        return tweet ? item.read({ tweet, locale: context.locale }) : undefined;
      },
    })),
];
export const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'YYYY-MM-DD HH:mm:ss'] as const;
export function fieldsForScope(scope: TemplateScope): readonly TemplateField[] {
  return TEMPLATE_FIELDS.filter(
    (item) => scope !== 'textTemplate' || (!item.media && item.name !== 'extension'),
  );
}
