import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  upsertTweetRecord,
  recordOutput,
  listStorageRecords,
  deleteTweetRecord,
} from '../src/core/storage.js';
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());
it('deletes a source and all its outputs without removing other sources', async () => {
  for (const tweetId of ['1', '2']) {
    await upsertTweetRecord({
      tweetId,
      text: 'post',
      url: `https://x.com/alice/status/${tweetId}`,
      author: { id: '7', handle: 'alice', name: 'Alice' },
      media: [],
    });
    await recordOutput({ tweetId, outputType: 'tweet-card' });
    await recordOutput({ tweetId, outputType: 'copied-text' });
  }
  await deleteTweetRecord('1');
  const records = await listStorageRecords();
  expect(records.tweetRecords.map((record) => record.tweetId)).toEqual(['2']);
  expect(records.outputRecords.map((record) => record.tweetId)).toEqual(['2', '2']);
});
