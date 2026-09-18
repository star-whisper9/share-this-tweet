import type { TweetRecord } from '../shared/model.js';
import { getLocale, t } from '../shared/i18n.js';
import type {
  OutputRecord,
  OutputRecordInput,
  StorageArchive,
  StoredTweetRecord,
} from '../shared/storage-model.js';
import type {
  StorageArchiveResponse,
  StorageMutationResponse,
  StorageRecordsResponse,
  StoredTweetRecordResponse,
} from '../shared/protocol.js';

function readMutationResponse(response: unknown): void {
  const result = response as StorageMutationResponse;
  if (!result || result.ok !== true) {
    throw new Error(
      result && 'error' in result ? result.error : t('core.storage.serviceInvalidResponse'),
    );
  }
}

export async function saveTweetRecord(record: TweetRecord): Promise<void> {
  readMutationResponse(
    await browser.runtime.sendMessage({ type: 'save-tweet-record', record, locale: getLocale() }),
  );
}

export async function recordOutput(output: OutputRecordInput): Promise<void> {
  readMutationResponse(
    await browser.runtime.sendMessage({ type: 'record-output', output, locale: getLocale() }),
  );
}

export async function getStoredTweetRecord(
  tweetId: string,
): Promise<StoredTweetRecord | undefined> {
  const result = (await browser.runtime.sendMessage({
    type: 'get-tweet-record',
    tweetId,
    locale: getLocale(),
  })) as StoredTweetRecordResponse;
  if (!result || result.ok !== true) {
    throw new Error(
      result && 'error' in result ? result.error : t('core.storage.serviceInvalidResponse'),
    );
  }
  return result.record;
}

export async function listStorageRecords(): Promise<{
  tweetRecords: StoredTweetRecord[];
  outputRecords: OutputRecord[];
}> {
  const result = (await browser.runtime.sendMessage({
    type: 'list-storage-records',
    locale: getLocale(),
  })) as StorageRecordsResponse;
  if (!result || result.ok !== true) {
    throw new Error(
      result && 'error' in result ? result.error : t('core.storage.serviceInvalidResponse'),
    );
  }
  return { tweetRecords: result.tweetRecords, outputRecords: result.outputRecords };
}

export async function deleteStoredTweetRecord(tweetId: string): Promise<void> {
  readMutationResponse(
    await browser.runtime.sendMessage({
      type: 'delete-tweet-record',
      tweetId,
      locale: getLocale(),
    }),
  );
}

export async function clearStoredRecords(): Promise<void> {
  readMutationResponse(
    await browser.runtime.sendMessage({ type: 'clear-storage-records', locale: getLocale() }),
  );
}

export async function exportStorageRecords(): Promise<StorageArchive> {
  const result = (await browser.runtime.sendMessage({
    type: 'export-storage-records',
    locale: getLocale(),
  })) as StorageArchiveResponse;
  if (!result || result.ok !== true) {
    throw new Error(
      result && 'error' in result ? result.error : t('core.storage.serviceInvalidResponse'),
    );
  }
  return result.archive;
}

export async function importStorageRecords(archive: StorageArchive): Promise<void> {
  readMutationResponse(
    await browser.runtime.sendMessage({
      type: 'import-storage-records',
      archive,
      locale: getLocale(),
    }),
  );
}
