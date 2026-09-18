import { parseMediaSourceMetadata, type MediaSourceMetadata } from '../shared/media-source.js';
import { getLocale, t, type Locale } from '../shared/i18n.js';

export interface MediaSourceWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  locale?: Locale;
}

function runWorker(
  input: Blob,
  source: MediaSourceMetadata | undefined,
  options: MediaSourceWorkerOptions,
): Promise<Blob | MediaSourceMetadata | undefined> {
  const locale = options.locale ?? getLocale();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new Error(t('core.worker.invalidTimeout', {}, locale)));
  if (options.signal?.aborted)
    return Promise.reject(
      options.signal.reason ?? new Error(t('core.worker.cancelled', {}, locale)),
    );
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      // Call only from an extension page/background, never the X content-script realm.
      worker = new Worker(browser.runtime.getURL('workers/media-source.worker.js'));
    } catch (error) {
      reject(error);
      return;
    }
    const id = crypto.randomUUID();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown, result?: Blob | MediaSourceMetadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const abort = () =>
      finish(options.signal?.reason ?? new Error(t('core.worker.cancelled', {}, locale)));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message !== 'object' ||
        message === null ||
        !('id' in message) ||
        message.id !== id
      ) {
        finish(new Error(t('core.worker.invalidResponse', {}, locale)));
        return;
      }
      const response = message as { ok?: unknown; result?: unknown; error?: unknown };
      if (response.ok === false) {
        finish(
          new Error(
            typeof response.error === 'string'
              ? response.error
              : t('core.worker.failed', {}, locale),
          ),
        );
      } else if (response.ok !== true)
        finish(new Error(t('core.worker.invalidResponse', {}, locale)));
      else if (source) {
        if (
          !(response.result instanceof Blob) ||
          response.result.type !== 'video/mp4' ||
          !response.result.size
        )
          finish(new Error(t('core.worker.invalidMp4', {}, locale)));
        else finish(undefined, response.result);
      } else {
        try {
          finish(
            undefined,
            response.result === undefined ? undefined : parseMediaSourceMetadata(response.result),
          );
        } catch (error) {
          finish(error);
        }
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      finish(new Error(event.message || t('core.worker.error', {}, locale)));
    };
    worker.onmessageerror = () =>
      finish(new Error(t('core.worker.communicationFailed', {}, locale)));
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error(t('core.worker.timeout', {}, locale))), timeoutMs);
    try {
      worker.postMessage({
        id,
        type: source ? 'embed' : 'read',
        blob: input,
        locale,
        ...(source ? { source } : {}),
      });
    } catch (error) {
      finish(error);
    }
  });
}

export async function embedMp4SourceInWorker(
  input: Blob,
  source: MediaSourceMetadata,
  options: MediaSourceWorkerOptions = {},
): Promise<Blob> {
  const result = await runWorker(input, parseMediaSourceMetadata(source), options);
  if (!(result instanceof Blob)) throw new Error(t('core.worker.invalidMp4', {}, options.locale));
  return result;
}

export async function readMp4SourceInWorker(
  input: Blob,
  options: MediaSourceWorkerOptions = {},
): Promise<MediaSourceMetadata | undefined> {
  const result = await runWorker(input, undefined, options);
  if (result instanceof Blob)
    throw new Error(t('core.worker.invalidReadResponse', {}, options.locale));
  return result;
}
