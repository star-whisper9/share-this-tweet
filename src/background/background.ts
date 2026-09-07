import type { DownloadMediaResponse, ExtensionMessage } from '../shared/protocol.js';
import { getTweetRecord, recordOutput, StorageError, upsertTweetRecord } from '../core/storage.js';

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isExtensionMessage(message)) return;
  if (message.type === 'download-media') return downloadMedia(message.url, message.filename);
  if (message.type === 'save-tweet-record') return saveTweetRecord(message.record);
  if (message.type === 'record-output') return saveOutputRecord(message.output);
  if (message.type === 'get-tweet-record') return readTweetRecord(message.tweetId);
});

function isExtensionMessage(message: unknown): message is ExtensionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false;
  const candidate = message as {
    type?: unknown;
    url?: unknown;
    filename?: unknown;
    tweetId?: unknown;
    record?: unknown;
    output?: unknown;
  };
  if (candidate.type === 'download-media')
    return typeof candidate.url === 'string' && typeof candidate.filename === 'string';
  if (candidate.type === 'get-tweet-record')
    return typeof candidate.tweetId === 'string' && candidate.tweetId.length > 0;
  if (candidate.type === 'save-tweet-record') return isTweetRecord(candidate.record);
  if (candidate.type === 'record-output') return isOutputRecordInput(candidate.output);
  return false;
}

function isTweetRecord(
  value: unknown,
): value is Extract<ExtensionMessage, { type: 'save-tweet-record' }>['record'] {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as {
    tweetId?: unknown;
    url?: unknown;
    text?: unknown;
    author?: unknown;
    media?: unknown;
  };
  return (
    typeof record.tweetId === 'string' &&
    typeof record.url === 'string' &&
    typeof record.text === 'string' &&
    typeof record.author === 'object' &&
    record.author !== null &&
    Array.isArray(record.media)
  );
}

function isOutputRecordInput(
  value: unknown,
): value is Extract<ExtensionMessage, { type: 'record-output' }>['output'] {
  if (typeof value !== 'object' || value === null) return false;
  const output = value as { tweetId?: unknown; outputType?: unknown };
  return typeof output.tweetId === 'string' && typeof output.outputType === 'string';
}

async function saveTweetRecord(
  record: Extract<ExtensionMessage, { type: 'save-tweet-record' }>['record'],
) {
  try {
    await upsertTweetRecord(record);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function saveOutputRecord(
  output: Extract<ExtensionMessage, { type: 'record-output' }>['output'],
) {
  try {
    await recordOutput(output);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function readTweetRecord(tweetId: string) {
  try {
    return { ok: true as const, record: await getTweetRecord(tweetId) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function downloadMedia(url: string, filename: string): Promise<DownloadMediaResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: '媒体地址无效' };
  }

  if (
    parsed.protocol !== 'https:' ||
    !['pbs.twimg.com', 'video.twimg.com'].includes(parsed.hostname)
  ) {
    return { ok: false, error: '媒体地址不属于允许的 X 媒体域名' };
  }
  if (!filename || /[\\/\u0000]/.test(filename)) {
    return { ok: false, error: '文件名无效' };
  }

  try {
    const downloadId = await browser.downloads.download({
      url,
      filename,
      saveAs: false,
    });
    return { ok: true, downloadId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `下载失败：${message}` };
  }
}
