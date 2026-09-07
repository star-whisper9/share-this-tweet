import type { TweetRecord } from './model.js';

export type ExtensionMessage =
  | { type: 'tweet-record'; record: TweetRecord }
  | { type: 'get-tweet-record'; tweetId: string }
  | { type: 'download-media'; url: string; filename: string };

export type DownloadMediaResponse =
  | { ok: true; downloadId: number }
  | { ok: false; error: string };
