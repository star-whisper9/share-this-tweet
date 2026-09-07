import type { TweetRecord } from '../shared/model.js';
import type {
  OutputRecord,
  OutputRecordInput,
  StoredTweetRecord,
} from '../shared/storage-model.js';

export const STORAGE_DATABASE_NAME = 'share-this-tweet';
export const STORAGE_DATABASE_VERSION = 1;
export const TWEET_RECORDS_STORE = 'tweetRecords';
export const OUTPUT_RECORDS_STORE = 'outputRecords';

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function createOutputRecord(
  input: OutputRecordInput,
  id = globalThis.crypto.randomUUID(),
  createdAt = new Date().toISOString(),
): OutputRecord {
  return { ...input, id, createdAt };
}

export function openStorageDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new StorageError('当前环境不支持 IndexedDB'));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DATABASE_NAME, STORAGE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const tweets = database.objectStoreNames.contains(TWEET_RECORDS_STORE)
        ? request.transaction!.objectStore(TWEET_RECORDS_STORE)
        : database.createObjectStore(TWEET_RECORDS_STORE, { keyPath: 'tweetId' });
      if (!tweets.indexNames.contains('url')) tweets.createIndex('url', 'url', { unique: false });
      if (!tweets.indexNames.contains('author.handle')) {
        tweets.createIndex('author.handle', 'author.handle', { unique: false });
      }
      if (!tweets.indexNames.contains('savedAt')) {
        tweets.createIndex('savedAt', 'savedAt', { unique: false });
      }

      const outputs = database.objectStoreNames.contains(OUTPUT_RECORDS_STORE)
        ? request.transaction!.objectStore(OUTPUT_RECORDS_STORE)
        : database.createObjectStore(OUTPUT_RECORDS_STORE, { keyPath: 'id' });
      if (!outputs.indexNames.contains('tweetId'))
        outputs.createIndex('tweetId', 'tweetId', { unique: false });
      if (!outputs.indexNames.contains('outputType')) {
        outputs.createIndex('outputType', 'outputType', { unique: false });
      }
      if (!outputs.indexNames.contains('filename')) {
        outputs.createIndex('filename', 'filename', { unique: false });
      }
      if (!outputs.indexNames.contains('createdAt')) {
        outputs.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new StorageError('无法打开来源记录数据库', { cause: request.error }));
    request.onblocked = () => reject(new StorageError('来源记录数据库被旧连接阻塞'));
  });
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openStorageDatabase();
  try {
    return await operation(database);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('来源记录数据库操作失败', { cause: error });
  } finally {
    database.close();
  }
}

export async function upsertTweetRecord(record: TweetRecord): Promise<StoredTweetRecord> {
  const stored: StoredTweetRecord = { ...record, savedAt: new Date().toISOString() };
  await withDatabase(async (database) => {
    const transaction = database.transaction(TWEET_RECORDS_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    await requestResult(transaction.objectStore(TWEET_RECORDS_STORE).put(stored));
    await complete;
  });
  return stored;
}

export async function getTweetRecord(tweetId: string): Promise<StoredTweetRecord | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(TWEET_RECORDS_STORE, 'readonly');
    const complete = transactionComplete(transaction);
    const result = await requestResult(transaction.objectStore(TWEET_RECORDS_STORE).get(tweetId));
    await complete;
    return result as StoredTweetRecord | undefined;
  });
}

export async function recordOutput(input: OutputRecordInput): Promise<OutputRecord> {
  const output = createOutputRecord(input);
  await withDatabase(async (database) => {
    const transaction = database.transaction(OUTPUT_RECORDS_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    await requestResult(transaction.objectStore(OUTPUT_RECORDS_STORE).add(output));
    await complete;
  });
  return output;
}
