import { parseMediaSourceMetadata, type MediaSourceMetadata } from '../shared/media-source.js';

export interface MediaSourceWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function runWorker(
  input: Blob,
  source: MediaSourceMetadata | undefined,
  options: MediaSourceWorkerOptions,
): Promise<Blob | MediaSourceMetadata | undefined> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new Error('媒体处理超时设置无效'));
  if (options.signal?.aborted)
    return Promise.reject(options.signal.reason ?? new Error('媒体处理已取消'));
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
    const abort = () => finish(options.signal?.reason ?? new Error('媒体处理已取消'));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message !== 'object' ||
        message === null ||
        !('id' in message) ||
        message.id !== id
      ) {
        finish(new Error('媒体处理线程返回了无效结果'));
        return;
      }
      const response = message as { ok?: unknown; result?: unknown; error?: unknown };
      if (response.ok === false) {
        finish(new Error(typeof response.error === 'string' ? response.error : '媒体处理失败'));
      } else if (response.ok !== true) finish(new Error('媒体处理线程返回了无效结果'));
      else if (source) {
        if (
          !(response.result instanceof Blob) ||
          response.result.type !== 'video/mp4' ||
          !response.result.size
        )
          finish(new Error('媒体处理线程未生成有效 MP4'));
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
      finish(new Error(event.message || '媒体处理线程发生错误'));
    };
    worker.onmessageerror = () => finish(new Error('媒体处理线程通信失败'));
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('媒体处理超时，已停止处理')), timeoutMs);
    try {
      worker.postMessage({
        id,
        type: source ? 'embed' : 'read',
        blob: input,
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
  if (!(result instanceof Blob)) throw new Error('媒体处理线程未生成 MP4');
  return result;
}

export async function readMp4SourceInWorker(
  input: Blob,
  options: MediaSourceWorkerOptions = {},
): Promise<MediaSourceMetadata | undefined> {
  const result = await runWorker(input, undefined, options);
  if (result instanceof Blob) throw new Error('来源读取线程返回了无效结果');
  return result;
}
