import type { MediaRecord, MediaVariant, TweetRecord, TweetQuote } from './model.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function getObject(value: unknown, key: string): JsonObject | undefined {
  return asObject(asObject(value)?.[key]);
}

function getArray(value: unknown, key: string): unknown[] | undefined {
  const result = asObject(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const result = asObject(value)?.[key];
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  const result = asObject(value)?.[key];
  return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
}

function normalizePublishedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function getOriginalPhotoUrl(url: string): string {
  const base = url.split('?')[0];
  const extension = base.match(/\.([a-z0-9]+)$/i)?.[1];
  return extension ? `${base}?format=${extension}&name=orig` : `${base}?name=orig`;
}

function normalizeAvatarUrl(url: string): string {
  // X commonly sends the small `_normal` variant. Request the larger variant
  // for the exported frame, while retaining the original URL shape for paths
  // that do not use one of X's known size suffixes.
  return url.replace(/_(?:mini|normal|bigger)(?=\.[a-z0-9]+(?:$|\?))/i, '_400x400');
}

function normalizeMedia(media: unknown, index: number): MediaRecord | undefined {
  const value = asObject(media);
  const type = getString(value, 'type');
  if (!value || !type) return undefined;

  if (type === 'photo') {
    const url = getString(value, 'media_url_https') ?? getString(value, 'media_url');
    if (!url) return undefined;
    const originalInfo = getObject(value, 'original_info');
    return {
      index,
      type: 'photo',
      originalUrl: getOriginalPhotoUrl(url),
      width: getNumber(originalInfo, 'width'),
      height: getNumber(originalInfo, 'height'),
    };
  }

  if (type !== 'video' && type !== 'animated_gif') return undefined;
  const videoInfo = getObject(value, 'video_info');
  const variants: MediaVariant[] = (getArray(videoInfo, 'variants') ?? [])
    .map<MediaVariant | undefined>((candidate) => {
      const variant = asObject(candidate);
      const url = getString(variant, 'url');
      const mime = getString(variant, 'content_type');
      if (!url || !mime) return undefined;
      const bitrate = getNumber(variant, 'bitrate');
      return bitrate === undefined ? { url, mime } : { url, mime, bitrate };
    })
    .filter((variant): variant is MediaVariant => variant !== undefined);

  return {
    index,
    type,
    variants,
    width: getNumber(getObject(videoInfo, 'original_info'), 'width'),
    height: getNumber(getObject(videoInfo, 'original_info'), 'height'),
  };
}

function removeMediaEntityUrls(text: string, legacy: JsonObject): string {
  const entityGroups = [getObject(legacy, 'entities'), getObject(legacy, 'extended_entities')];
  const mediaUrls = entityGroups
    .flatMap((group) => getArray(group, 'media') ?? [])
    .map((item) => getString(item, 'url'))
    .filter((url): url is string => url !== undefined);

  let normalized = text;
  for (const url of mediaUrls) {
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized.replace(new RegExp(`[ \\t]*${escapedUrl}[ \\t]*`, 'g'), ' ');
  }
  return normalized
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function unwrapTweet(value: JsonObject): JsonObject {
  if (value.__typename === 'TweetWithVisibilityResults') {
    return getObject(value, 'tweet') ?? value;
  }
  return getObject(value, 'tweet') ?? value;
}

export function normalizeTweetCandidate(candidate: unknown): TweetRecord | undefined {
  return normalizeCandidate(candidate, true);
}

function normalizeCandidate(candidate: unknown, includeQuote: boolean): TweetRecord | undefined {
  const input = asObject(candidate);
  if (!input) return undefined;

  const isGraphqlTweet =
    input.__typename === 'Tweet' || input.__typename === 'TweetWithVisibilityResults';
  const isLegacyTweet =
    typeof input.id_str === 'string' &&
    (typeof input.full_text === 'string' || typeof input.text === 'string') &&
    (getObject(input, 'user') !== undefined || typeof input.user_id_str === 'string');
  if (!isGraphqlTweet && !isLegacyTweet) return undefined;

  const tweet = unwrapTweet(input);
  const legacy = getObject(tweet, 'legacy') ?? tweet;
  const tweetId =
    getString(tweet, 'rest_id') ?? getString(legacy, 'id_str') ?? getString(tweet, 'id_str');
  if (!tweetId) return undefined;

  const user = getObject(legacy, 'user');
  const userResults = getObject(getObject(tweet, 'core'), 'user_results');
  const userResult = getObject(userResults, 'result');
  const userResultLegacy = getObject(userResult, 'legacy');
  const userResultCore = getObject(userResult, 'core');
  const authorId =
    getString(user, 'id_str') ??
    getString(userResult, 'id_str') ??
    getString(userResult, 'rest_id') ??
    getString(legacy, 'user_id_str') ??
    '';
  const handle =
    getString(user, 'screen_name') ??
    getString(userResultLegacy, 'screen_name') ??
    getString(userResultCore, 'screen_name') ??
    '';
  const name =
    getString(user, 'name') ??
    getString(userResultLegacy, 'name') ??
    getString(userResultCore, 'name') ??
    handle;
  const avatarUrlValue =
    getString(user, 'profile_image_url_https') ??
    getString(userResultLegacy, 'profile_image_url_https') ??
    getString(userResult, 'profile_image_url_https') ??
    getString(userResultCore, 'profile_image_url_https') ??
    getString(getObject(userResult, 'avatar'), 'image_url');
  const avatarUrl = avatarUrlValue ? normalizeAvatarUrl(avatarUrlValue) : undefined;
  const media = (
    getArray(getObject(legacy, 'extended_entities'), 'media') ??
    getArray(legacy, 'media') ??
    []
  )
    .map((item, index) => normalizeMedia(item, index + 1))
    .filter((item): item is MediaRecord => item !== undefined);
  const note = getObject(getObject(getObject(tweet, 'note_tweet'), 'note_tweet_results'), 'result');
  const text = removeMediaEntityUrls(
    getString(note, 'text') ?? getString(legacy, 'full_text') ?? getString(legacy, 'text') ?? '',
    legacy,
  );
  const urlHandle = handle.replace(/^@+/, '');

  return {
    tweetId,
    url: urlHandle
      ? `https://x.com/${urlHandle}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`,
    text,
    author: { id: authorId, handle, name, avatarUrl },
    publishedAt: normalizePublishedAt(getString(legacy, 'created_at')),
    media,
    ...(includeQuote ? quoteFields(tweet, legacy, tweetId) : {}),
  };
}

function quoteFields(
  tweet: JsonObject,
  legacy: JsonObject,
  parentId: string,
): { quote?: TweetQuote } {
  const result =
    getObject(getObject(tweet, 'quoted_status_result'), 'result') ??
    getObject(legacy, 'quoted_status');
  const record = result ? normalizeCandidate(result, false) : undefined;
  const target = record?.tweetId ?? getString(legacy, 'quoted_status_id_str');
  if (target === parentId) return {};
  if (!target && !result && legacy.is_quote_status !== true) return {};
  const tweetId = target && /^\d+$/.test(target) ? target : undefined;
  const unavailable =
    result && ['TweetUnavailable', 'TweetTombstone'].includes(String(result.__typename));
  return {
    quote: {
      ...(tweetId ? { tweetId, url: record?.url ?? `https://x.com/i/status/${tweetId}` } : {}),
      status: record ? 'available' : unavailable ? 'unavailable' : 'pending',
      ...(record ? { record } : {}),
    },
  };
}
