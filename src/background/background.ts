import type { DownloadMediaResponse, ExtensionMessage } from '../shared/protocol.js';
import type { PrepareSourcedMediaResponse } from '../shared/protocol.js';
import { embedMp4SourceInWorker } from '../core/media-source-client.js';
import { parseMediaSourceMetadata, type MediaSourceMetadata } from '../shared/media-source.js';
import {
  clearStorageRecords,
  deleteTweetRecord,
  exportStorageRecords,
  getTweetRecord,
  importStorageRecords,
  listStorageRecords,
  recordOutput,
  StorageError,
  upsertTweetRecord,
} from '../core/storage.js';

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isExtensionMessage(message)) return;
  if (message.type === 'download-media') return downloadMedia(message.url, message.filename);
  if (message.type === 'download-sourced-media')
    return downloadSourcedMedia(message.url, message.filename, message.source);
  if (message.type === 'prepare-sourced-media')
    return prepareSourcedMedia(message.url, message.source);
  if (message.type === 'save-tweet-record') return saveTweetRecord(message.record);
  if (message.type === 'record-output') return saveOutputRecord(message.output);
  if (message.type === 'get-tweet-record') return readTweetRecord(message.tweetId);
  if (message.type === 'list-storage-records') return readStorageRecords();
  if (message.type === 'delete-tweet-record') return removeTweetRecord(message.tweetId);
  if (message.type === 'clear-storage-records') return clearRecords();
  if (message.type === 'export-storage-records') return exportRecords();
  if (message.type === 'import-storage-records') return importRecords(message.archive);
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
    archive?: unknown;
    source?: unknown;
  };
  if (candidate.type === 'download-media')
    return typeof candidate.url === 'string' && typeof candidate.filename === 'string';
  if (candidate.type === 'download-sourced-media')
    return (
      typeof candidate.url === 'string' &&
      typeof candidate.filename === 'string' &&
      typeof candidate.source === 'object' &&
      candidate.source !== null
    );
  if (candidate.type === 'prepare-sourced-media')
    return (
      typeof candidate.url === 'string' &&
      typeof candidate.source === 'object' &&
      candidate.source !== null
    );
  if (candidate.type === 'get-tweet-record')
    return typeof candidate.tweetId === 'string' && candidate.tweetId.length > 0;
  if (candidate.type === 'save-tweet-record') return isTweetRecord(candidate.record);
  if (candidate.type === 'record-output') return isOutputRecordInput(candidate.output);
  if (candidate.type === 'delete-tweet-record')
    return typeof candidate.tweetId === 'string' && candidate.tweetId.length > 0;
  if (candidate.type === 'clear-storage-records') return true;
  if (candidate.type === 'import-storage-records')
    return typeof candidate.archive === 'object' && candidate.archive !== null;
  if (candidate.type === 'list-storage-records' || candidate.type === 'export-storage-records')
    return true;
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

async function readStorageRecords() {
  try {
    return { ok: true as const, ...(await listStorageRecords()) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function removeTweetRecord(tweetId: string) {
  try {
    await deleteTweetRecord(tweetId);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function clearRecords() {
  try {
    await clearStorageRecords();
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function exportRecords() {
  try {
    return { ok: true as const, archive: await exportStorageRecords() };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function importRecords(
  archive: Extract<ExtensionMessage, { type: 'import-storage-records' }>['archive'],
) {
  try {
    await importStorageRecords(archive);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof StorageError ? error.message : String(error),
    };
  }
}

async function downloadMedia(url: string, filename: string): Promise<DownloadMediaResponse> {
  const validationError = validateDownloadRequest(url, filename);
  if (validationError) return { ok: false, error: validationError };

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

const MAX_SOURCE_MEDIA_SIZE = 512 * 1024 * 1024;
const MAX_ACTIVE_SOURCE_TASKS = 2;
const SOURCE_FETCH_TIMEOUT_MS = 90_000;
const SOURCE_WORKER_TIMEOUT_MS = 120_000;
const DOWNLOAD_COMPLETION_TIMEOUT_MS = 30 * 60_000;
let activeSourceTasks = 0;
const pendingDownloads = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  settlePendingDownload(delta.id, state, delta.error?.current);
});

function settlePendingDownload(
  downloadId: number,
  state: 'complete' | 'interrupted',
  error?: string,
): void {
  const pending = pendingDownloads.get(downloadId);
  if (!pending) return;
  pendingDownloads.delete(downloadId);
  if (state === 'complete') pending.resolve();
  else pending.reject(new Error(`浏览器保存中断${error ? `：${error}` : ''}`));
}

export function validateDownloadRequest(url: string, filename?: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '媒体地址无效';
  }

  if (
    parsed.protocol !== 'https:' ||
    !['pbs.twimg.com', 'video.twimg.com'].includes(parsed.hostname)
  ) {
    return '媒体地址不属于允许的 X 媒体域名';
  }
  if (
    filename !== undefined &&
    (!filename || [...filename].length > 180 || /[\\/\u0000]/.test(filename))
  ) {
    return '文件名无效';
  }
  return undefined;
}

export async function readBoundedResponse(
  response: Response,
  maximumBytes = MAX_SOURCE_MEDIA_SIZE,
  onLimitExceeded: () => void = () => {},
): Promise<Blob> {
  const contentLength = response.headers.get('content-length');
  const declaredSize = contentLength === null ? undefined : Number(contentLength);
  if (declaredSize !== undefined && Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    onLimitExceeded();
    throw new Error('媒体超过允许的大小，无法写入来源信息');
  }
  if (!response.body) throw new Error('浏览器无法以受限内存方式读取媒体');
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        onLimitExceeded();
        throw new Error('媒体超过允许的大小，无法写入来源信息');
      }
      // Network response byte streams are ArrayBuffer-backed in Firefox. Keep
      // each chunk as a Blob part so the bounded reader does not copy it again.
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new Error('媒体响应为空');
  return new Blob(chunks, { type: response.headers.get('content-type') ?? 'video/mp4' });
}

async function fetchSourceMedia(url: string): Promise<Blob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`媒体请求失败：HTTP ${response.status}`);
    return await readBoundedResponse(response, MAX_SOURCE_MEDIA_SIZE, () => controller.abort());
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDownloadCompletion(downloadId: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (operation: () => void): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        operation();
      };
      pendingDownloads.set(downloadId, {
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error)),
      });
      timeout = setTimeout(() => {
        pendingDownloads.delete(downloadId);
        reject(new Error('等待浏览器完成保存超时'));
      }, DOWNLOAD_COMPLETION_TIMEOUT_MS);
      void browser.downloads
        .search({ id: downloadId })
        .then(([item]) => {
          if (!item) {
            const pending = pendingDownloads.get(downloadId);
            if (pending) pending.reject(new Error('浏览器没有返回下载任务'));
            return;
          }
          if (item.state === 'complete' || item.state === 'interrupted')
            settlePendingDownload(downloadId, item.state, item.error);
        })
        .catch((error) => {
          const pending = pendingDownloads.get(downloadId);
          if (pending)
            pending.reject(
              new Error(
                `无法确认浏览器保存状态：${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        });
    });
  } finally {
    pendingDownloads.delete(downloadId);
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function withSourceTask<T>(operation: () => Promise<T>): Promise<T> {
  if (activeSourceTasks >= MAX_ACTIVE_SOURCE_TASKS)
    throw new Error('已有来源媒体正在处理，请稍后重试');
  activeSourceTasks += 1;
  try {
    return await operation();
  } finally {
    activeSourceTasks -= 1;
  }
}

async function buildSourcedMedia(url: string, source: MediaSourceMetadata): Promise<Blob> {
  const urlError = validateDownloadRequest(url);
  if (urlError) throw new Error(urlError);
  const validatedSource = parseMediaSourceMetadata(source);
  const input = await fetchSourceMedia(url);
  return embedMp4SourceInWorker(input, validatedSource, { timeoutMs: SOURCE_WORKER_TIMEOUT_MS });
}

async function prepareSourcedMedia(
  url: string,
  source: MediaSourceMetadata,
): Promise<PrepareSourcedMediaResponse> {
  try {
    return { ok: true, blob: await withSourceTask(() => buildSourcedMedia(url, source)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function downloadSourcedMedia(
  url: string,
  filename: string,
  source: MediaSourceMetadata,
): Promise<DownloadMediaResponse> {
  const validationError = validateDownloadRequest(url, filename);
  if (validationError) return { ok: false, error: validationError };
  let objectUrl: string | undefined;
  try {
    return await withSourceTask(async () => {
      const output = await buildSourcedMedia(url, source);
      objectUrl = URL.createObjectURL(output);
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename,
        saveAs: false,
      });
      await waitForDownloadCompletion(downloadId);
      return { ok: true, downloadId };
    });
  } catch (error) {
    return {
      ok: false,
      error: `写入来源失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
