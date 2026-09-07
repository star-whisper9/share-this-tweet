import type { TweetRecord } from './model.js';
import type {
  OutputRecord,
  OutputRecordInput,
  StorageArchive,
  StoredTweetRecord,
} from './storage-model.js';

export type ExtensionMessage =
  | { type: 'tweet-record'; record: TweetRecord }
  | { type: 'get-tweet-record'; tweetId: string }
  | { type: 'save-tweet-record'; record: TweetRecord }
  | { type: 'record-output'; output: OutputRecordInput }
  | { type: 'list-storage-records' }
  | { type: 'delete-tweet-record'; tweetId: string }
  | { type: 'clear-storage-records' }
  | { type: 'export-storage-records' }
  | { type: 'import-storage-records'; archive: StorageArchive }
  | { type: 'download-media'; url: string; filename: string };

export type DownloadMediaResponse = { ok: true; downloadId: number } | { ok: false; error: string };

export type StorageMutationResponse = { ok: true } | { ok: false; error: string };
export type StoredTweetRecordResponse =
  { ok: true; record?: StoredTweetRecord } | { ok: false; error: string };
export type StorageArchiveResponse =
  { ok: true; archive: StorageArchive } | { ok: false; error: string };
export type StorageRecordsResponse =
  | { ok: true; tweetRecords: StoredTweetRecord[]; outputRecords: OutputRecord[] }
  | { ok: false; error: string };
