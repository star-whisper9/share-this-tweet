import { VIDEO_PORT_NAME, type VideoRenderRequest } from '../core/video-client.js';
import { getMediaDownloadTarget } from '../core/media.js';
import { ImageResources } from '../core/image-resources.js';
import { IMAGE_PALETTES } from '../core/image-theme.js';
import { renderFrameStrip } from '../core/frame.js';
import { isLocale, t, type Locale } from '../shared/i18n.js';
import type { MediaRecord } from '../shared/model.js';
import type { VideoRenderInput, VideoRenderWorkerMessage } from '../shared/video-render.js';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
let activePort: BrowserPort | undefined;
function validateRequest(value: unknown): value is VideoRenderRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<VideoRenderRequest>;
  return (
    r.type === 'start' &&
    typeof r.id === 'string' &&
    r.id.length <= 80 &&
    isLocale(r.locale) &&
    (r.theme === 'dark' || r.theme === 'light') &&
    (r.style === 'seamless' || r.style === 'gallery') &&
    ['original', 'top', 'bottom'].includes(r.frame ?? '') &&
    typeof r.frameTemplate === 'string' &&
    r.frameTemplate.length <= 10000 &&
    !!r.record &&
    typeof r.record.tweetId === 'string' &&
    typeof r.record.text === 'string' &&
    !!r.record.author &&
    typeof r.record.author.name === 'string' &&
    typeof r.record.author.handle === 'string' &&
    Array.isArray(r.record.media) &&
    r.record.media.length <= 4 &&
    Array.isArray(r.indexes) &&
    r.indexes.length > 0 &&
    r.indexes.length <= 4 &&
    new Set(r.indexes).size === r.indexes.length &&
    r.indexes.every((index) => Number.isInteger(index))
  );
}
function allowedURL(value: string, locale: Locale): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error(t('dynamic.badUrl', {}, locale));
  return url.href;
}
async function fetchInput(
  media: MediaRecord,
  remaining: number,
  signal: AbortSignal,
  locale: Locale,
): Promise<Blob> {
  const url = allowedURL(getMediaDownloadTarget(media).url, locale);
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal });
  if (!response.ok) throw new Error(t('dynamic.fetchFailed', { status: response.status }, locale));
  const size = Number(response.headers.get('content-length'));
  if (size > remaining) {
    await response.body?.cancel();
    throw new Error(t('dynamic.inputLimit', {}, locale));
  }
  if (!response.body) throw new Error(t('dynamic.emptyInput', {}, locale));
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > remaining) {
        await reader.cancel();
        throw new Error(t('dynamic.inputLimit', {}, locale));
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes || (size > 0 && bytes !== size)) throw new Error(t('dynamic.emptyInput', {}, locale));
  return new Blob(chunks);
}

/** A live port owns each Worker: disconnect, cancel, timeout and errors all terminate it. */
export function handleVideoPort(port: BrowserPort): void {
  if (port.name !== VIDEO_PORT_NAME) return;
  const controller = new AbortController();
  const resources = new ImageResources();
  let worker: Worker | undefined;
  let id: string | undefined;
  let locale: Locale = 'zh-CN';
  let finished = false;
  let layoutReceived = false;
  let lastProgressAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: unknown, blob?: Blob): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    controller.abort();
    resources.dispose();
    worker?.terminate();
    if (activePort === port) activePort = undefined;
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    if (id) {
      try {
        port.postMessage(
          error
            ? { type: 'error', id, error: error instanceof Error ? error.message : String(error) }
            : { type: 'done', id, blob },
        );
      } catch {
        /* The peer already disconnected; resources above are still released. */
      }
    }
    port.disconnect();
  };
  const onDisconnect = () => finish(new Error(t('dynamic.cancelled', {}, locale)));
  const post = (message: object) => {
    if (!finished) port.postMessage({ ...message, id });
  };
  const run = async (request: VideoRenderRequest): Promise<void> => {
    if (activePort) throw new Error(t('dynamic.busy', {}, locale));
    activePort = port;
    timer = setTimeout(() => finish(new Error(t('dynamic.timeout', {}, locale))), 300_000);
    const media = request.indexes.map((index) =>
      request.record.media.find((item) => item.index === index),
    );
    if (
      media.some((item) => !item || !['photo', 'video', 'animated_gif'].includes(item.type)) ||
      !media.some((item) => item?.type !== 'photo')
    )
      throw new Error(t('dynamic.invalidRequest', {}, locale));
    post({ type: 'progress', phase: 'downloading' });
    const inputs: VideoRenderInput[] = [];
    let total = 0;
    for (const item of media as MediaRecord[]) {
      const blob = await fetchInput(item, MAX_INPUT_BYTES - total, controller.signal, locale);
      total += blob.size;
      inputs.push({ blob, type: item.type });
    }
    controller.signal.throwIfAborted();
    worker = new Worker(browser.runtime.getURL('workers/video-render.worker.js'));
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(event.message || t('dynamic.invalidResponse', {}, locale)));
    };
    worker.onmessageerror = () => finish(new Error(t('dynamic.invalidResponse', {}, locale)));
    worker.onmessage = (event: MessageEvent<VideoRenderWorkerMessage>) => {
      const message = event.data;
      if (!message || message.id !== id)
        return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
      if (message.type === 'progress') {
        if (
          message.phase !== 'encoding' ||
          Date.now() - lastProgressAt >= 200 ||
          message.progress === 1
        ) {
          lastProgressAt = Date.now();
          post(message);
        }
      } else if (message.type === 'layout') {
        if (
          layoutReceived ||
          !Number.isInteger(message.width) ||
          message.width < 2 ||
          message.width > 1280 ||
          !Number.isFinite(message.duration) ||
          message.duration <= 0 ||
          message.duration > 30
        )
          return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
        layoutReceived = true;
        void (async () => {
          if (request.frame === 'original') worker?.postMessage({ type: 'frame', id });
          else {
            const strip = await renderFrameStrip(
              request.record,
              media[0]!,
              message.width,
              request.frameTemplate,
              resources,
              request.theme,
              locale,
            );
            if (strip.width !== message.width || strip.height > 1024 || strip.height % 2)
              throw new Error(t('dynamic.frameLimit', {}, locale));
            if (!finished)
              worker?.postMessage({ type: 'frame', id, blob: strip.blob, height: strip.height });
          }
        })().catch(finish);
      } else if (
        message.type === 'done' &&
        message.blob instanceof Blob &&
        message.blob.type === 'video/mp4' &&
        message.blob.size > 0 &&
        message.blob.size <= MAX_INPUT_BYTES
      )
        finish(undefined, message.blob);
      else if (message.type === 'error') finish(new Error(message.error));
      else finish(new Error(t('dynamic.invalidResponse', {}, locale)));
    };
    worker.postMessage({
      type: 'start',
      id,
      inputs,
      style: request.style,
      background: IMAGE_PALETTES[request.theme].background,
      frame: request.frame,
      locale,
    });
  };
  const onMessage = (message: unknown): void => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'ping') {
      if (id) post({ type: 'pong' });
      return;
    }
    if (id || !validateRequest(message)) {
      if (
        !id &&
        message &&
        typeof message === 'object' &&
        'id' in message &&
        typeof message.id === 'string'
      )
        id = message.id;
      finish(new Error(t('dynamic.invalidRequest', {}, locale)));
      return;
    }
    id = message.id;
    locale = message.locale;
    void run(message).catch(finish);
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
}
