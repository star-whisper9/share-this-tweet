import { waitForBrowserDownload } from '../core/download-monitor.js';
import { isTweetRecord } from '../shared/record-validation.js';
import { handleExportJobMessage, initializeExportJobs } from './export-jobs.js';
import type { DownloadMediaResponse, ExtensionMessage } from '../shared/protocol.js';
import type { PrepareSourcedMediaResponse } from '../shared/protocol.js';
import { getLocale, setLocale, t, type Locale } from '../shared/i18n.js';
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
  upsertTweetRecord,
} from '../core/storage.js';

void initializeExportJobs().catch((error) =>
  console.error('Export queue initialization failed', error),
);

browser.runtime.onMessage.addListener((message: unknown) => {
  const jobResponse = handleExportJobMessage(message);
  if (jobResponse !== undefined) return jobResponse;
  if (!isExtensionMessage(message)) return;
  const locale = message.locale ?? getLocale();
  setLocale(locale);
  if (message.type === 'download-media')
    return downloadMedia(message.url, message.filename, locale);
  if (message.type === 'download-sourced-media')
    return downloadSourcedMedia(message.url, message.filename, message.source, locale);
  if (message.type === 'prepare-sourced-media')
    return prepareSourcedMedia(message.url, message.source, locale);
  if (message.type === 'save-tweet-record')
    return storageResponse(async () => {
      await upsertTweetRecord(message.record);
    });
  if (message.type === 'record-output')
    return storageResponse(async () => {
      await recordOutput(message.output);
    });
  if (message.type === 'get-tweet-record')
    return storageResponse(async () => ({ record: await getTweetRecord(message.tweetId) }));
  if (message.type === 'list-storage-records') return storageResponse(listStorageRecords);
  if (message.type === 'delete-tweet-record')
    return storageResponse(() => deleteTweetRecord(message.tweetId));
  if (message.type === 'clear-storage-records') return storageResponse(clearStorageRecords);
  if (message.type === 'export-storage-records')
    return storageResponse(async () => ({ archive: await exportStorageRecords() }));
  if (message.type === 'import-storage-records')
    return storageResponse(() => importStorageRecords(message.archive));
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

function isOutputRecordInput(
  value: unknown,
): value is Extract<ExtensionMessage, { type: 'record-output' }>['output'] {
  if (typeof value !== 'object' || value === null) return false;
  const output = value as { tweetId?: unknown; outputType?: unknown };
  return typeof output.tweetId === 'string' && typeof output.outputType === 'string';
}

async function storageResponse<T extends object | void>(operation: () => Promise<T>) {
  try {
    return { ok: true as const, ...(await operation()) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

async function downloadMedia(
  url: string,
  filename: string,
  locale: Locale,
): Promise<DownloadMediaResponse> {
  const validationError = validateDownloadRequest(url, filename, locale);
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
    return { ok: false, error: t('core.background.downloadFailed', { message }, locale) };
  }
}

const MAX_SOURCE_MEDIA_SIZE = 512 * 1024 * 1024;
const MAX_ACTIVE_SOURCE_TASKS = 2;
const SOURCE_FETCH_TIMEOUT_MS = 90_000;
const SOURCE_WORKER_TIMEOUT_MS = 120_000;
let activeSourceTasks = 0;

export function validateDownloadRequest(
  url: string,
  filename?: string,
  locale: Locale = getLocale(),
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return t('core.background.invalidMediaUrl', {}, locale);
  }

  if (
    parsed.protocol !== 'https:' ||
    !['pbs.twimg.com', 'video.twimg.com'].includes(parsed.hostname)
  ) {
    return t('core.background.disallowedMediaDomain', {}, locale);
  }
  if (
    filename !== undefined &&
    (!filename || [...filename].length > 180 || /[\\/\u0000]/.test(filename))
  ) {
    return t('core.background.invalidFilename', {}, locale);
  }
  return undefined;
}

export async function readBoundedResponse(
  response: Response,
  maximumBytes = MAX_SOURCE_MEDIA_SIZE,
  onLimitExceeded: () => void = () => {},
  locale: Locale = getLocale(),
): Promise<Blob> {
  const contentLength = response.headers.get('content-length');
  const declaredSize = contentLength === null ? undefined : Number(contentLength);
  if (declaredSize !== undefined && Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    onLimitExceeded();
    throw new Error(t('core.background.mediaTooLarge', {}, locale));
  }
  if (!response.body) throw new Error(t('core.background.streamUnavailable', {}, locale));
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
        throw new Error(t('core.background.mediaTooLarge', {}, locale));
      }
      // Network response byte streams are ArrayBuffer-backed in Firefox. Keep
      // each chunk as a Blob part so the bounded reader does not copy it again.
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new Error(t('core.background.emptyMediaResponse', {}, locale));
  return new Blob(chunks, { type: response.headers.get('content-type') ?? 'video/mp4' });
}

async function fetchSourceMedia(url: string, locale: Locale): Promise<Blob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!response.ok)
      throw new Error(t('core.background.mediaRequestFailed', { status: response.status }, locale));
    return await readBoundedResponse(
      response,
      MAX_SOURCE_MEDIA_SIZE,
      () => controller.abort(),
      locale,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function withSourceTask<T>(operation: () => Promise<T>, locale: Locale): Promise<T> {
  if (activeSourceTasks >= MAX_ACTIVE_SOURCE_TASKS)
    throw new Error(t('core.background.sourceBusy', {}, locale));
  activeSourceTasks += 1;
  try {
    return await operation();
  } finally {
    activeSourceTasks -= 1;
  }
}

async function buildSourcedMedia(
  url: string,
  source: MediaSourceMetadata,
  locale: Locale,
): Promise<Blob> {
  const urlError = validateDownloadRequest(url, undefined, locale);
  if (urlError) throw new Error(urlError);
  const validatedSource = parseMediaSourceMetadata(source);
  const input = await fetchSourceMedia(url, locale);
  return embedMp4SourceInWorker(input, validatedSource, {
    timeoutMs: SOURCE_WORKER_TIMEOUT_MS,
    locale,
  });
}

async function prepareSourcedMedia(
  url: string,
  source: MediaSourceMetadata,
  locale: Locale,
): Promise<PrepareSourcedMediaResponse> {
  try {
    return {
      ok: true,
      blob: await withSourceTask(() => buildSourcedMedia(url, source, locale), locale),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function downloadSourcedMedia(
  url: string,
  filename: string,
  source: MediaSourceMetadata,
  locale: Locale,
): Promise<DownloadMediaResponse> {
  const validationError = validateDownloadRequest(url, filename, locale);
  if (validationError) return { ok: false, error: validationError };
  let objectUrl: string | undefined;
  try {
    return await withSourceTask(async () => {
      const output = await buildSourcedMedia(url, source, locale);
      objectUrl = URL.createObjectURL(output);
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename,
        saveAs: false,
      });
      await waitForBrowserDownload(downloadId, { locale });
      return { ok: true, downloadId };
    }, locale);
  } catch (error) {
    return {
      ok: false,
      error: t(
        'core.background.writeSourceFailed',
        { message: error instanceof Error ? error.message : String(error) },
        locale,
      ),
    };
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
