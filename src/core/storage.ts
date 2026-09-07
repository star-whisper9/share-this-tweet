import type { TweetRecord } from '../shared/model.js';
import type {
  OutputRecord,
  OutputRecordInput,
  OutputType,
  StorageArchive,
  StoredTweetRecord,
} from '../shared/storage-model.js';

export const STORAGE_DATABASE_NAME = 'share-this-tweet';
export const STORAGE_DATABASE_VERSION = 1;
export const TWEET_RECORDS_STORE = 'tweetRecords';
export const OUTPUT_RECORDS_STORE = 'outputRecords';
const OUTPUT_TYPES: OutputType[] = [
  'original-media',
  'framed-image',
  'tweet-card',
  'shared-text',
  'shared-image',
  'copied-text',
];

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
  if (!OUTPUT_TYPES.includes(input.outputType)) {
    throw new StorageError(`不支持的输出记录类型：${input.outputType}`);
  }
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

export async function listStorageRecords(): Promise<{
  tweetRecords: StoredTweetRecord[];
  outputRecords: OutputRecord[];
}> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(
      [TWEET_RECORDS_STORE, OUTPUT_RECORDS_STORE],
      'readonly',
    );
    const complete = transactionComplete(transaction);
    const tweetsRequest = transaction.objectStore(TWEET_RECORDS_STORE).getAll();
    const outputsRequest = transaction.objectStore(OUTPUT_RECORDS_STORE).getAll();
    const [tweetRecords, outputRecords] = await Promise.all([
      requestResult(tweetsRequest),
      requestResult(outputsRequest),
    ]);
    await complete;
    return {
      tweetRecords: (tweetRecords as StoredTweetRecord[]).sort((left, right) =>
        right.savedAt.localeCompare(left.savedAt),
      ),
      outputRecords: (outputRecords as OutputRecord[]).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    };
  });
}

export async function deleteTweetRecord(tweetId: string): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [TWEET_RECORDS_STORE, OUTPUT_RECORDS_STORE],
      'readwrite',
    );
    const complete = transactionComplete(transaction);
    const outputStore = transaction.objectStore(OUTPUT_RECORDS_STORE);
    const outputs = (await requestResult(outputStore.getAll())) as OutputRecord[];
    transaction.objectStore(TWEET_RECORDS_STORE).delete(tweetId);
    for (const output of outputs) {
      if (output.tweetId === tweetId) outputStore.delete(output.id);
    }
    await complete;
  });
}

export async function clearStorageRecords(): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [TWEET_RECORDS_STORE, OUTPUT_RECORDS_STORE],
      'readwrite',
    );
    const complete = transactionComplete(transaction);
    transaction.objectStore(TWEET_RECORDS_STORE).clear();
    transaction.objectStore(OUTPUT_RECORDS_STORE).clear();
    await complete;
  });
}

function isStoredTweetRecord(value: unknown): value is StoredTweetRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as {
    tweetId?: unknown;
    url?: unknown;
    text?: unknown;
    author?: unknown;
    media?: unknown;
    savedAt?: unknown;
  };
  return (
    typeof record.tweetId === 'string' &&
    typeof record.url === 'string' &&
    typeof record.text === 'string' &&
    typeof record.author === 'object' &&
    record.author !== null &&
    Array.isArray(record.media) &&
    typeof record.savedAt === 'string'
  );
}

function isOutputRecord(value: unknown): value is OutputRecord {
  if (typeof value !== 'object' || value === null) return false;
  const output = value as {
    id?: unknown;
    tweetId?: unknown;
    outputType?: unknown;
    createdAt?: unknown;
  };
  return (
    typeof output.id === 'string' &&
    typeof output.tweetId === 'string' &&
    typeof output.outputType === 'string' &&
    OUTPUT_TYPES.includes(output.outputType as OutputType) &&
    typeof output.createdAt === 'string'
  );
}

export function validateStorageArchive(value: unknown): StorageArchive {
  if (typeof value !== 'object' || value === null) throw new StorageError('来源记录归档不是对象');
  const archive = value as Partial<StorageArchive>;
  if (archive.schemaVersion !== 1) throw new StorageError('不支持的来源记录归档版本');
  if (typeof archive.exportedAt !== 'string') throw new StorageError('来源记录归档缺少导出时间');
  if (!Array.isArray(archive.tweetRecords) || !archive.tweetRecords.every(isStoredTweetRecord)) {
    throw new StorageError('来源记录归档包含无效推文记录');
  }
  if (!Array.isArray(archive.outputRecords) || !archive.outputRecords.every(isOutputRecord)) {
    throw new StorageError('来源记录归档包含无效输出记录');
  }
  return archive as StorageArchive;
}

export async function exportStorageRecords(): Promise<StorageArchive> {
  const records = await listStorageRecords();
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    ...records,
  };
}

export async function importStorageRecords(value: unknown): Promise<void> {
  const archive = validateStorageArchive(value);
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [TWEET_RECORDS_STORE, OUTPUT_RECORDS_STORE],
      'readwrite',
    );
    const complete = transactionComplete(transaction);
    const tweets = transaction.objectStore(TWEET_RECORDS_STORE);
    const outputs = transaction.objectStore(OUTPUT_RECORDS_STORE);
    for (const record of archive.tweetRecords) tweets.put(record);
    for (const output of archive.outputRecords) outputs.put(output);
    await complete;
  });
}
