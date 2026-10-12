import { isRecordTimestamp, isTweetRecord } from '../shared/record-validation.js';
import { t } from '../shared/i18n.js';
import { mergeTweetRecords, type TweetRecord } from '../shared/model.js';
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
  'sourced-media',
  'framed-image',
  'tweet-card',
  'row-tweet-card',
  'stitched-image',
  'stitched-video',
  'framed-video',
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
    throw new StorageError(t('core.storage.invalidOutputType', { type: input.outputType }));
  }
  return { ...input, id, createdAt };
}

export function openStorageDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new StorageError(t('core.storage.indexedDbUnsupported')));
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
      reject(new StorageError(t('core.storage.openFailed'), { cause: request.error }));
    request.onblocked = () => reject(new StorageError(t('core.storage.blocked')));
  });
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openStorageDatabase();
  try {
    return await operation(database);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(t('core.storage.operationFailed'), { cause: error });
  } finally {
    database.close();
  }
}

export async function upsertTweetRecord(record: TweetRecord): Promise<StoredTweetRecord> {
  let stored: StoredTweetRecord = { ...record, savedAt: new Date().toISOString() };
  await withDatabase(async (database) => {
    const transaction = database.transaction(TWEET_RECORDS_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    const store = transaction.objectStore(TWEET_RECORDS_STORE);
    await Promise.all([
      (async () => {
        const existing = (await requestResult(store.get(record.tweetId))) as
          StoredTweetRecord | undefined;
        if (existing) stored = { ...mergeTweetRecords(existing, record), savedAt: stored.savedAt };
        await requestResult(store.put(stored));
      })(),
      complete,
    ]);
  });
  return stored;
}

export async function getTweetRecord(tweetId: string): Promise<StoredTweetRecord | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(TWEET_RECORDS_STORE, 'readonly');
    const complete = transactionComplete(transaction);
    const [result] = await Promise.all([
      requestResult(transaction.objectStore(TWEET_RECORDS_STORE).get(tweetId)),
      complete,
    ]);
    return result as StoredTweetRecord | undefined;
  });
}

export async function recordOutput(input: OutputRecordInput): Promise<OutputRecord> {
  const output = createOutputRecord(input);
  await withDatabase(async (database) => {
    const transaction = database.transaction(OUTPUT_RECORDS_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    await Promise.all([
      requestResult(transaction.objectStore(OUTPUT_RECORDS_STORE).add(output)),
      complete,
    ]);
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
      complete,
    ]);
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
    transaction.objectStore(TWEET_RECORDS_STORE).delete(tweetId);
    const cursor = outputStore.index('tweetId').openKeyCursor(IDBKeyRange.only(tweetId));
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      outputStore.delete(item.primaryKey);
      item.continue();
    };
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
  return isTweetRecord(value) && 'savedAt' in value && isRecordTimestamp(value.savedAt);
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
    isRecordTimestamp(output.createdAt)
  );
}

export function validateStorageArchive(value: unknown): StorageArchive {
  if (typeof value !== 'object' || value === null)
    throw new StorageError(t('core.storage.archiveNotObject'));
  const archive = value as Partial<StorageArchive>;
  if (archive.schemaVersion !== 1)
    throw new StorageError(t('core.storage.unsupportedArchiveVersion'));
  if (!isRecordTimestamp(archive.exportedAt))
    throw new StorageError(t('core.storage.archiveMissingDate'));
  if (!Array.isArray(archive.tweetRecords) || !archive.tweetRecords.every(isStoredTweetRecord)) {
    throw new StorageError(t('core.storage.invalidTweetRecord'));
  }
  if (!Array.isArray(archive.outputRecords) || !archive.outputRecords.every(isOutputRecord)) {
    throw new StorageError(t('core.storage.invalidOutputRecord'));
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
