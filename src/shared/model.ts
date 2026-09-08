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
  altText?: string;
  durationMs?: number;
}

export interface TweetAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  description?: string;
  location?: string;
  url?: string;
  createdAt?: string;
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
  language?: string;
  replyToTweetId?: string;
  replyToUserId?: string;
  sensitive?: boolean;
  editIds?: string[];
  observedAt?: string;
  textSource?: 'partial' | 'full' | 'note';
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
    altText: incoming.altText ?? current.altText,
    durationMs: incoming.durationMs ?? current.durationMs,
  };
}

export function mergeTweetRecords(current: TweetRecord, incoming: TweetRecord): TweetRecord {
  const newer =
    !!incoming.observedAt && (!current.observedAt || incoming.observedAt >= current.observedAt);
  const mediaByIndex = new Map(current.media.map((media) => [media.index, media]));
  for (const media of incoming.media) {
    const existing = mediaByIndex.get(media.index);
    mediaByIndex.set(
      media.index,
      existing
        ? newer
          ? mergeMediaRecords(existing, media)
          : mergeMediaRecords(media, existing)
        : media,
    );
  }

  const preferred = newer ? incoming : current;
  const fallback = newer ? current : incoming;
  const authorHandle = preferValue(preferred.author.handle, fallback.author.handle) ?? '';
  const authorName = preferValue(preferred.author.name, fallback.author.name) ?? authorHandle;

  if (current.tweetId !== incoming.tweetId) throw new Error('Cannot merge different tweets');
  if (current.author.id && incoming.author.id && current.author.id !== incoming.author.id)
    throw new Error('Conflicting tweet author identity');
  const rank = { partial: 0, full: 1, note: 2 };
  const currentRank = rank[current.textSource ?? 'partial'];
  const incomingRank = rank[incoming.textSource ?? 'partial'];
  const useIncomingText =
    incomingRank > currentRank || (incomingRank === currentRank && (newer || !current.text));
  return {
    tweetId: current.tweetId,
    url:
      current.url.includes('/i/status/') && !incoming.url.includes('/i/status/')
        ? incoming.url
        : current.url,
    text: useIncomingText ? incoming.text : current.text,
    textSource: useIncomingText ? incoming.textSource : current.textSource,
    observedAt: preferred.observedAt ?? fallback.observedAt,
    language: preferred.language ?? fallback.language,
    replyToTweetId: preferred.replyToTweetId ?? fallback.replyToTweetId,
    replyToUserId: preferred.replyToUserId ?? fallback.replyToUserId,
    sensitive: preferred.sensitive ?? fallback.sensitive,
    editIds: preferred.editIds ?? fallback.editIds,
    author: {
      id: preferValue(current.author.id, incoming.author.id) ?? '',
      handle: authorHandle,
      name: authorName,
      avatarUrl: preferValue(preferred.author.avatarUrl, fallback.author.avatarUrl),
      description: preferred.author.description ?? fallback.author.description,
      location: preferred.author.location ?? fallback.author.location,
      url: preferred.author.url ?? fallback.author.url,
      createdAt: preferred.author.createdAt ?? fallback.author.createdAt,
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
