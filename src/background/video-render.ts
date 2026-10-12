import type { BackgroundVideoRenderRequest } from '../shared/video-job.js';
import { getMediaDownloadTarget } from '../core/media.js';
import { ImageResources } from '../core/image-resources.js';
import { IMAGE_PALETTES } from '../core/image-theme.js';
import { renderFrameStrip } from '../core/frame.js';
import { isLocale, t, type Locale } from '../shared/i18n.js';
import type { MediaRecord } from '../shared/model.js';
import { loadSettings } from '../shared/settings.js';
import { normalizeGifLimits, type GifLimits } from '../shared/gif-experiment.js';
import {
  assertVideoLimits,
  VideoLimitError,
  type VideoLimits,
} from '../shared/video-experiment.js';
import type { VideoRenderInput, VideoRenderWorkerMessage } from '../shared/video-render.js';

let activeRender = false;
function validateRequest(value: unknown): value is BackgroundVideoRenderRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<BackgroundVideoRenderRequest>;
  return (
    r.type === 'start' &&
    typeof r.id === 'string' &&
    r.id.length <= 80 &&
    isLocale(r.locale) &&
    (r.outputFormat === undefined || r.outputFormat === 'mp4' || r.outputFormat === 'gif') &&
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
interface FetchedInput {
  blob: Blob;
  limitError?: VideoLimitError;
}

export interface BackgroundVideoRenderOptions {
  signal: AbortSignal;
  /** A queued job captures its guard values at submission time. The current
   * experimental switch is still checked before this value is accepted. */
  limits?: VideoLimits;
  gifLimits?: GifLimits;
  onProgress?: (progress: {
    phase: 'downloading' | 'loading' | 'probing' | 'encoding';
    progress?: number;
  }) => void;
  onDiagnostics?: (
    message: Omit<Extract<VideoRenderWorkerMessage, { type: 'diagnostics' }>, 'id'>,
  ) => void;
}

export type BackgroundVideoRenderResult =
  { type: 'done'; blob: Blob } | { type: 'fallback'; reason: string; blob?: Blob };

async function fetchInput(
  media: MediaRecord,
  totalInputBytes: number,
  limits: VideoLimits,
  keepDownloadingOnLimit: boolean,
  signal: AbortSignal,
  locale: Locale,
): Promise<FetchedInput> {
  const url = allowedURL(getMediaDownloadTarget(media).url, locale);
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal });
  if (!response.ok) throw new Error(t('dynamic.fetchFailed', { status: response.status }, locale));
  const size = Number(response.headers.get('content-length'));
  let limitError: VideoLimitError | undefined;
  const checkLimit = (inputBytes: number): void => {
    if (limitError) return;
    try {
      assertVideoLimits(limits, { inputBytes }, locale);
    } catch (error) {
      if (error instanceof VideoLimitError && keepDownloadingOnLimit) {
        limitError = error;
        return;
      }
      throw error;
    }
  };
  if (Number.isFinite(size) && size > 0) {
    try {
      checkLimit(totalInputBytes + size);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
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
      try {
        // Content-Length is absent on some X responses, so this must be
        // enforced while streaming too. Do it before retaining the chunk.
        checkLimit(totalInputBytes + bytes);
      } catch (error) {
        await reader.cancel();
        throw error;
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes || (size > 0 && bytes !== size)) throw new Error(t('dynamic.emptyInput', {}, locale));
  return {
    // X dynamic variants are selected as MP4. Preserve that MIME type so the
    // single-item fallback can save the already-downloaded source directly.
    blob: new Blob(chunks, { type: media.type === 'photo' ? '' : 'video/mp4' }),
    ...(limitError ? { limitError } : {}),
  };
}

/**
 * Run one queued dynamic export. Its lifetime is controlled by the supplied
 * AbortSignal; only one renderer can own the FFmpeg Worker at a time.
 */
export async function renderVideoInBackground(
  request: BackgroundVideoRenderRequest,
  options: BackgroundVideoRenderOptions,
): Promise<BackgroundVideoRenderResult> {
  const { signal } = options;
  signal.throwIfAborted();
  const locale = request.locale;
  const settings = await loadSettings();
  signal.throwIfAborted();
  if (!validateRequest(request)) throw new Error(t('dynamic.invalidRequest', {}, locale));
  const gif = request.outputFormat === 'gif';
  if (gif ? settings.experimentalGif === false : !settings.experimentalVideo)
    throw new Error(t(gif ? 'gif.disabled' : 'experiment.disabled', {}, locale));
  const gifLimits = gif ? normalizeGifLimits(options.gifLimits ?? settings.gifLimits) : undefined;
  const limits: VideoLimits = gifLimits
    ? {
        maxInputMiB: gifLimits.maxInputMiB,
        maxDurationSeconds: gifLimits.maxDurationSeconds,
        maxOutputPixels: gifLimits.maxSourcePixels,
        maxFrameRate: 0,
      }
    : (options.limits ?? settings.videoLimits);
  if (activeRender) throw new Error(t('dynamic.busy', {}, locale));
  activeRender = true;
  const resources = new ImageResources();
  let worker: Worker | undefined;
  try {
    const media = request.indexes.map((index) =>
      request.record.media.find((item) => item.index === index),
    );
    if (
      media.some((item) => !item || !['photo', 'video', 'animated_gif'].includes(item.type)) ||
      !media.some((item) => item?.type !== 'photo')
    )
      throw new Error(t('dynamic.invalidRequest', {}, locale));
    if (
      gif &&
      (media.length !== 1 || media[0]?.type !== 'animated_gif' || request.frame !== 'original')
    )
      throw new Error(t('dynamic.invalidRequest', {}, locale));
    if (media.length === 1 && media[0]?.type === 'animated_gif' && request.frame !== 'original')
      throw new Error(t('gif.invalidFrame', {}, locale));

    const downloadStarted = performance.now();
    options.onProgress?.({ phase: 'downloading' });
    const inputs: VideoRenderInput[] = [];
    let inputBytes = 0;
    let inputLimitError: VideoLimitError | undefined;
    for (const item of media as MediaRecord[]) {
      const result = await fetchInput(item, inputBytes, limits, media.length === 1, signal, locale);
      inputs.push({ blob: result.blob, type: item.type });
      inputBytes += result.blob.size;
      inputLimitError ??= result.limitError;
    }
    if (inputLimitError)
      return {
        type: 'fallback',
        reason: inputLimitError.message,
        ...(inputs[0] ? { blob: inputs[0].blob } : {}),
      };
    const downloadMs = performance.now() - downloadStarted;
    signal.throwIfAborted();
    worker = new Worker(browser.runtime.getURL('workers/video-render.worker.js'));

    return await new Promise<BackgroundVideoRenderResult>((resolve, reject) => {
      let settled = false;
      let layoutReceived = false;
      let lastProgressAt = 0;
      const finish = (error?: unknown, result?: BackgroundVideoRenderResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (worker) {
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.onmessage = null;
          worker.terminate();
          worker = undefined;
        }
        if (error !== undefined) reject(error);
        else if (result) resolve(result);
        else reject(new Error(t('dynamic.invalidResponse', {}, locale)));
      };
      const abort = () => finish(signal.reason ?? new Error(t('dynamic.cancelled', {}, locale)));
      worker!.onerror = (event) => {
        event.preventDefault();
        finish(new Error(event.message || t('dynamic.invalidResponse', {}, locale)));
      };
      worker!.onmessageerror = () => finish(new Error(t('dynamic.invalidResponse', {}, locale)));
      worker!.onmessage = (event: MessageEvent<VideoRenderWorkerMessage>) => {
        const message = event.data;
        if (!message || message.id !== request.id)
          return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
        if (message.type === 'diagnostics') {
          options.onDiagnostics?.({
            type: 'diagnostics',
            sample: message.sample,
            metadata: { ...message.metadata, inputBytes, downloadMs },
          });
        } else if (message.type === 'progress') {
          if (
            message.phase !== 'encoding' ||
            Date.now() - lastProgressAt >= 200 ||
            message.progress === 1
          ) {
            lastProgressAt = Date.now();
            options.onProgress?.({
              phase: message.phase,
              ...(message.progress === undefined ? {} : { progress: message.progress }),
            });
          }
        } else if (message.type === 'layout') {
          if (
            layoutReceived ||
            !Number.isInteger(message.width) ||
            message.width < (gif ? 1 : 2) ||
            !Number.isFinite(message.duration) ||
            message.duration <= 0
          )
            return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
          layoutReceived = true;
          void (async () => {
            if (request.frame === 'original')
              worker?.postMessage({ type: 'frame', id: request.id });
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
              if (strip.width !== message.width || strip.height % 2)
                throw new Error(t('dynamic.frameLimit', {}, locale));
              if (!settled)
                worker?.postMessage({
                  type: 'frame',
                  id: request.id,
                  blob: strip.blob,
                  height: strip.height,
                });
            }
          })().catch(finish);
        } else if (
          message.type === 'done' &&
          message.blob instanceof Blob &&
          message.blob.type === (gif ? 'image/gif' : 'video/mp4') &&
          message.blob.size > 0
        )
          finish(undefined, { type: 'done', blob: message.blob });
        else if (message.type === 'error' && message.limitExceeded)
          finish(undefined, {
            type: 'fallback',
            reason: message.error,
            ...(inputs.length === 1 && inputs[0] ? { blob: inputs[0].blob } : {}),
          });
        else if (message.type === 'error') finish(new Error(message.error));
        else finish(new Error(t('dynamic.invalidResponse', {}, locale)));
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        worker!.postMessage({
          type: 'start',
          id: request.id,
          inputs,
          style: request.style,
          background: IMAGE_PALETTES[request.theme].background,
          frame: request.frame,
          locale,
          limits,
          ...(gif ? { outputFormat: 'gif' } : {}),
        });
      } catch (error) {
        finish(error);
      }
    });
  } catch (error) {
    // A multi-item processing limit asks the queue to render a static fallback.
    if (error instanceof VideoLimitError) return { type: 'fallback', reason: error.message };
    throw error;
  } finally {
    resources.dispose();
    worker?.terminate();
    activeRender = false;
  }
}
