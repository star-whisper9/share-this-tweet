import type { MediaRecord, TweetRecord } from './model.js';

/** File provenance describes the source publisher, not ownership or permission. */
export interface MediaSourceMetadata {
  schemaVersion: 1;
  platform: 'x';
  tweetId: string;
  tweetUrl: string;
  publisher: { id?: string; handle: string; name: string };
  publishedAt?: string;
  media: { index: number; type: 'video' | 'animated_gif' };
  tool: { name: 'share-this-tweet'; version: string };
}

export const MAX_MEDIA_SOURCE_BYTES = 16 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('来源信息结构无效');
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error('来源信息字段无效');
  return value;
}

function identity(value: unknown): string {
  const result = string(value, 30);
  if (!/^[1-9]\d*$/.test(result)) throw new Error('来源标识无效');
  return result;
}

/** Return a bounded, plain object; never propagate unknown file-supplied fields. */
export function parseMediaSourceMetadata(value: unknown): MediaSourceMetadata {
  const source = object(value);
  if (source.schemaVersion !== 1 || source.platform !== 'x')
    throw new Error('不支持此来源信息版本或平台');
  const tweetId = identity(source.tweetId);
  const tweetUrl = string(source.tweetUrl, 256);
  let url: URL;
  try {
    url = new URL(tweetUrl);
  } catch {
    throw new Error('来源推文链接无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'x.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(`^/(?:[A-Za-z0-9_]{1,15}|i)/status/${tweetId}$`).test(url.pathname) ||
    url.href !== tweetUrl
  )
    throw new Error('来源推文链接无效');
  const publisher = object(source.publisher);
  const handle = string(publisher.handle, 16);
  if (!/^@[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('来源发布者账号无效');
  const media = object(source.media);
  if (
    !Number.isInteger(media.index) ||
    (media.index as number) < 1 ||
    (media.index as number) > 4 ||
    (media.type !== 'video' && media.type !== 'animated_gif')
  )
    throw new Error('来源媒体信息无效');
  const tool = object(source.tool);
  if (tool.name !== 'share-this-tweet') throw new Error('来源导出工具无效');
  const version = string(tool.version, 40);
  if (!/^\d{1,9}(?:\.\d{1,9}){0,3}$/.test(version)) throw new Error('来源导出版本无效');
  let publishedAt: string | undefined;
  if (source.publishedAt !== undefined) {
    publishedAt = string(source.publishedAt, 40);
    if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('来源发布时间无效');
  }
  const result: MediaSourceMetadata = {
    schemaVersion: 1,
    platform: 'x',
    tweetId,
    tweetUrl,
    publisher: {
      ...(publisher.id !== undefined ? { id: identity(publisher.id) } : {}),
      handle,
      name: string(publisher.name, 256),
    },
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    media: { index: media.index as number, type: media.type },
    tool: { name: 'share-this-tweet', version },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_MEDIA_SOURCE_BYTES)
    throw new Error('来源信息过大');
  return result;
}

export function createMediaSourceMetadata(
  record: TweetRecord,
  media: MediaRecord,
  extensionVersion: string,
): MediaSourceMetadata {
  return parseMediaSourceMetadata({
    schemaVersion: 1,
    platform: 'x',
    tweetId: record.tweetId,
    tweetUrl: record.url,
    publisher: {
      ...(record.author.id ? { id: record.author.id } : {}),
      handle: `@${record.author.handle.replace(/^@+/, '')}`,
      name: record.author.name,
    },
    ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    media: { index: media.index, type: media.type },
    tool: { name: 'share-this-tweet', version: extensionVersion },
  });
}
