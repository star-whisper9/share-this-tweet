import type { TweetRecord } from './model.js';

export type OutputType =
  | 'original-media'
  | 'sourced-media'
  | 'framed-image'
  | 'tweet-card'
  | 'shared-text'
  | 'shared-image'
  | 'copied-text';

export interface StoredTweetRecord extends TweetRecord {
  savedAt: string;
}

export interface OutputRecord {
  id: string;
  tweetId: string;
  outputType: OutputType;
  filename?: string;
  mediaIndex?: number;
  createdAt: string;
}

export type OutputRecordInput = Omit<OutputRecord, 'id' | 'createdAt'> & {
  createdAt?: string;
};

export interface StorageArchive {
  schemaVersion: 1;
  exportedAt: string;
  tweetRecords: StoredTweetRecord[];
  outputRecords: OutputRecord[];
}
