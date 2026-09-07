import type { TweetRecord } from '../shared/model.js';
import type { OutputRecordInput, StoredTweetRecord } from '../shared/storage-model.js';
import type { StorageMutationResponse, StoredTweetRecordResponse } from '../shared/protocol.js';

function readMutationResponse(response: unknown): void {
  const result = response as StorageMutationResponse;
  if (!result || result.ok !== true) {
    throw new Error(result && 'error' in result ? result.error : '来源记录服务返回了无效结果');
  }
}

export async function saveTweetRecord(record: TweetRecord): Promise<void> {
  readMutationResponse(await browser.runtime.sendMessage({ type: 'save-tweet-record', record }));
}

export async function recordOutput(output: OutputRecordInput): Promise<void> {
  readMutationResponse(await browser.runtime.sendMessage({ type: 'record-output', output }));
}

export async function getStoredTweetRecord(
  tweetId: string,
): Promise<StoredTweetRecord | undefined> {
  const result = (await browser.runtime.sendMessage({
    type: 'get-tweet-record',
    tweetId,
  })) as StoredTweetRecordResponse;
  if (!result || result.ok !== true) {
    throw new Error(result && 'error' in result ? result.error : '来源记录服务返回了无效结果');
  }
  return result.record;
}
