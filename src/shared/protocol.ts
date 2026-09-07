import type { TweetRecord } from './model.js';

export type ExtensionMessage =
  | { type: 'tweet-record'; record: TweetRecord }
  | { type: 'get-tweet-record'; tweetId: string }
  | { type: 'download-media'; tweetId: string; mediaIndex: number };
