export type MediaType = 'photo' | 'video' | 'animated_gif';

export interface MediaVariant {
  url: string;
  mime: string;
  bitrate?: number;
}

export interface MediaRecord {
  index: number;
  type: MediaType;
  originalUrl?: string;
  variants?: MediaVariant[];
  width?: number;
  height?: number;
}

export interface TweetAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl?: string;
}

export interface TweetQuote {
  tweetId?: string;
  url?: string;
  status: 'pending' | 'unavailable' | 'available';
  record?: Omit<TweetRecord, 'quote'>;
}

export function withoutQuote(record: TweetRecord): Omit<TweetRecord, 'quote'> {
  const { quote: _quote, ...content } = record;
  return content;
}

export interface TweetRecord {
  tweetId: string;
  url: string;
  text: string;
  author: TweetAuthor;
  publishedAt?: string;
  media: MediaRecord[];
  quote?: TweetQuote;
}

export function normalizeHandle(handle: string): string {
  return `@${handle.replace(/^@+/, '')}`;
}

export function getTweetIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/[^/]+\/status\/(\d+)/);
  return match?.[1];
}

function preferValue<T>(current: T | undefined, incoming: T | undefined): T | undefined {
  if (typeof current === 'string' && current.length > 0) return current;
  return incoming ?? current;
}

function mergeMediaRecords(current: MediaRecord, incoming: MediaRecord): MediaRecord {
  const variants = new Map((current.variants ?? []).map((variant) => [variant.url, variant]));
  for (const variant of incoming.variants ?? []) variants.set(variant.url, variant);

  return {
    ...current,
    ...incoming,
    originalUrl: preferValue(current.originalUrl, incoming.originalUrl),
    width: current.width ?? incoming.width,
    height: current.height ?? incoming.height,
    variants: Array.from(variants.values()),
  };
}

export function mergeTweetRecords(current: TweetRecord, incoming: TweetRecord): TweetRecord {
  const mediaByIndex = new Map(current.media.map((media) => [media.index, media]));
  for (const media of incoming.media) {
    const existing = mediaByIndex.get(media.index);
    mediaByIndex.set(media.index, existing ? mergeMediaRecords(existing, media) : media);
  }

  const authorHandle = preferValue(current.author.handle, incoming.author.handle) ?? '';
  const authorName = preferValue(current.author.name, incoming.author.name) ?? authorHandle;

  if (current.tweetId !== incoming.tweetId) throw new Error('Cannot merge different tweets');
  return {
    tweetId: current.tweetId,
    url:
      current.url.includes('/i/status/') && !incoming.url.includes('/i/status/')
        ? incoming.url
        : current.url,
    text: current.text.length >= incoming.text.length ? current.text : incoming.text,
    author: {
      id: preferValue(current.author.id, incoming.author.id) ?? '',
      handle: authorHandle,
      name: authorName,
      avatarUrl: preferValue(current.author.avatarUrl, incoming.author.avatarUrl),
    },
    publishedAt: current.publishedAt ?? incoming.publishedAt,
    media: Array.from(mediaByIndex.values()).sort((left, right) => left.index - right.index),
    ...(current.quote || incoming.quote
      ? { quote: mergeQuote(current.quote, incoming.quote) }
      : {}),
  };
}

function mergeQuote(current?: TweetQuote, incoming?: TweetQuote): TweetQuote | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  if (current.tweetId && incoming.tweetId && current.tweetId !== incoming.tweetId) return current;
  const record =
    current.record && incoming.record
      ? withoutQuote(mergeTweetRecords(current.record, incoming.record))
      : (current.record ?? incoming.record);
  return {
    tweetId: current.tweetId ?? incoming.tweetId,
    url: record?.url ?? current.url ?? incoming.url,
    status: record
      ? 'available'
      : incoming.status === 'unavailable'
        ? 'unavailable'
        : current.status,
    ...(record ? { record } : {}),
  };
}
