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

export interface TweetRecord {
  tweetId: string;
  url: string;
  text: string;
  author: TweetAuthor;
  publishedAt?: string;
  media: MediaRecord[];
}

export function normalizeHandle(handle: string): string {
  return `@${handle.replace(/^@+/, '')}`;
}

export function getTweetIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/[^/]+\/status\/(\d+)/);
  return match?.[1];
}
