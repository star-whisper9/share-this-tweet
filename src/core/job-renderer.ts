import { renderVideoInBackground } from '../background/video-render.js';
import { renderTweetCard } from './card.js';
import {
  buildCardFilename,
  buildFrameFilename,
  buildMediaFilename,
  buildSourcedMediaFilename,
  buildStitchFilename,
} from './filename.js';
import { renderPhotoFrame, type FrameOrientation } from './frame.js';
import { ImageResources } from './image-resources.js';
import { getMediaDownloadTarget } from './media.js';
import { embedMp4SourceInWorker } from './media-source-client.js';
import { renderStitchedMedia } from './stitch.js';
import type { VideoRenderRequest } from './video-client.js';
import {
  appendVideoDiagnostic,
  type VideoDiagnosticsReport,
  type VideoDiagnosticsReport as MutableVideoDiagnosticsReport,
} from './video-report.js';
import { type ExportJobFile, type ExportJobRequest } from '../shared/export-jobs.js';
import { createMediaSourceMetadata } from '../shared/media-source.js';
import type { MediaRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';

export interface ExportJobRendererCallbacks {
  signal: AbortSignal;
  onProgress: (message: string) => void;
  onDiagnostics: (report: VideoDiagnosticsReport) => void;
  onFile: (file: ExportJobFile) => Promise<void>;
  onWarning: (message: string) => void;
}

function outputType(
  media: MediaRecord,
  mode: 'original' | 'sourced' | 'framed',
): ExportJobFile['output']['outputType'] {
  if (mode === 'sourced') return 'sourced-media';
  if (mode === 'framed') return media.type === 'photo' ? 'framed-image' : 'framed-video';
  return 'original-media';
}

function extension(blob: Blob, locale: ExportJobRequest['locale']): 'png' | 'jpg' | 'webp' | 'mp4' {
  if (blob.type === 'image/png') return 'png';
  if (blob.type === 'image/jpeg') return 'jpg';
  if (blob.type === 'image/webp') return 'webp';
  if (blob.type === 'video/mp4') return 'mp4';
  throw new Error(t('content.stitchFormatError', {}, locale));
}

function allowedMediaURL(value: string, locale: ExportJobRequest['locale']): string {
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

async function fetchMedia(
  media: MediaRecord,
  signal: AbortSignal,
  locale: ExportJobRequest['locale'],
  maximumBytes = 0,
): Promise<Blob> {
  signal.throwIfAborted();
  const target = getMediaDownloadTarget(media);
  const response = await fetch(allowedMediaURL(target.url, locale), {
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(t('dynamic.fetchFailed', { status: response.status }, locale));
  const expected = Number(response.headers.get('content-length'));
  if (maximumBytes && Number.isFinite(expected) && expected > maximumBytes)
    throw new Error(t('core.background.mediaTooLarge', {}, locale));
  if (!response.body) throw new Error(t('dynamic.emptyInput', {}, locale));
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (maximumBytes && size > maximumBytes) {
        await reader.cancel();
        throw new Error(t('core.background.mediaTooLarge', {}, locale));
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!size || (Number.isFinite(expected) && expected > 0 && expected !== size))
    throw new Error(t('dynamic.emptyInput', {}, locale));
  return new Blob(chunks, { type: media.type === 'photo' ? '' : 'video/mp4' });
}

function createVideoReport(
  request: ExportJobRequest,
  indexes: number[],
  frame: 'original' | FrameOrientation,
): MutableVideoDiagnosticsReport {
  return {
    schemaVersion: 1,
    jobId: request.id,
    tweetId: request.record.tweetId,
    engine: { name: 'ffmpeg.wasm', coreVersion: '0.12.10', threading: 'single', gpu: false },
    startedAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    extensionVersion: browser.runtime.getManifest().version,
    status: 'running',
    elapsedMs: 0,
    mediaIndexes: indexes,
    frame,
    style: request.settings.stitchStyle,
    samples: [],
    phaseDurationsMs: {},
    droppedSamples: 0,
    memoryMeasurement: 'wasm-linear-memory-capacity-and-memfs-files-not-process-rss',
  };
}

async function renderDynamic(
  request: ExportJobRequest,
  media: MediaRecord[],
  frame: 'original' | FrameOrientation,
  callbacks: ExportJobRendererCallbacks,
): Promise<{ blob?: Blob; fallback?: { reason: string; blob?: Blob } }> {
  const report = createVideoReport(
    request,
    media.map((item) => item.index),
    frame,
  );
  const started = performance.now();
  const finish = (error?: unknown, blob?: Blob): void => {
    report.elapsedMs = performance.now() - started;
    report.finishedAt = new Date().toISOString();
    report.status = callbacks.signal.aborted ? 'cancelled' : error ? 'error' : 'completed';
    if (error) report.error = error instanceof Error ? error.message : String(error);
    if (blob) report.resultBytes = blob.size;
    callbacks.onDiagnostics(report);
  };
  callbacks.onDiagnostics(report);
  const workerRequest: VideoRenderRequest = {
    type: 'start',
    id: request.id,
    record: request.record,
    indexes: media.map((item) => item.index),
    style: request.settings.stitchStyle,
    frame,
    frameTemplate: request.settings.frameTemplate,
    theme: request.theme,
    locale: request.locale,
  };
  try {
    const result = await renderVideoInBackground(workerRequest, {
      signal: callbacks.signal,
      limits: request.settings.videoLimits,
      onProgress: ({ phase, progress }) => {
        callbacks.onProgress(
          phase === 'encoding' && progress !== undefined
            ? t(
                'dynamic.progress.encoding',
                { percent: Math.round(progress * 100) },
                request.locale,
              )
            : t(`dynamic.progress.${phase}`, {}, request.locale),
        );
      },
      onDiagnostics: ({ sample, metadata }) => {
        appendVideoDiagnostic(report, sample, performance.now() - started, metadata);
        callbacks.onDiagnostics(report);
      },
    });
    if (result.type === 'fallback') {
      finish(new Error(result.reason));
      return { fallback: { reason: result.reason, ...(result.blob ? { blob: result.blob } : {}) } };
    }
    finish(undefined, result.blob);
    return { blob: result.blob };
  } catch (error) {
    finish(error);
    throw error;
  }
}

async function emit(callbacks: ExportJobRendererCallbacks, file: ExportJobFile): Promise<void> {
  callbacks.signal.throwIfAborted();
  if (!file.blob.size) throw new Error(t('dynamic.invalidResponse'));
  await callbacks.onFile(file);
}

/** Render a complete, validated job snapshot. Download/persistence belongs to the queue. */
export async function renderExportJob(
  request: ExportJobRequest,
  callbacks: ExportJobRendererCallbacks,
): Promise<void> {
  const { record, settings, locale } = request;
  callbacks.signal.throwIfAborted();
  const resources = new ImageResources();
  const dispose = () => resources.dispose();
  callbacks.signal.addEventListener('abort', dispose, { once: true });
  try {
    if (request.kind === 'card' || request.kind === 'row-card') {
      callbacks.onProgress(t('content.cardLoading', {}, locale));
      const row = request.kind === 'row-card';
      const result = await renderTweetCard(record, record.media, {
        theme: request.theme,
        resources,
        locale,
        ...(row ? { mediaLayout: 'row' as const, stitchStyle: settings.stitchStyle } : {}),
      });
      const filename = buildCardFilename(record, record.media[0], settings.filenameTemplate, row);
      await emit(callbacks, {
        id: `${request.id}:card`,
        filename,
        blob: result.blob,
        output: {
          tweetId: record.tweetId,
          outputType: row ? 'row-tweet-card' : 'tweet-card',
          filename,
          ...(record.media[0] ? { mediaIndex: record.media[0].index } : {}),
        },
      });
      return;
    }

    if (request.kind === 'stitch') {
      const frame = request.frame ?? 'original';
      const animated =
        settings.experimentalVideo && record.media.some((item) => item.type !== 'photo');
      let fallbackWarning: string | undefined;
      if (animated) {
        const dynamic = await renderDynamic(request, record.media, frame, callbacks);
        if (dynamic.blob) {
          const filename = buildStitchFilename(
            record,
            settings.filenameTemplate,
            'mp4',
            frame !== 'original',
          );
          await emit(callbacks, {
            id: `${request.id}:stitch`,
            filename,
            blob: dynamic.blob,
            output: { tweetId: record.tweetId, outputType: 'stitched-video', filename },
          });
          return;
        }
        fallbackWarning = t(
          'experiment.fallbackStitch',
          { reason: dynamic.fallback!.reason },
          locale,
        );
      }
      callbacks.onProgress(t('content.stitchLoading', {}, locale));
      const blob = await renderStitchedMedia(
        record,
        settings,
        request.theme,
        resources,
        frame,
        locale,
      );
      const filename = buildStitchFilename(
        record,
        settings.filenameTemplate,
        extension(blob, locale),
        frame !== 'original',
      );
      await emit(callbacks, {
        id: `${request.id}:stitch`,
        filename,
        blob,
        output: { tweetId: record.tweetId, outputType: 'stitched-image', filename },
      });
      if (fallbackWarning) callbacks.onWarning(fallbackWarning);
      return;
    }

    const selections = request.media ?? [];
    const failures: string[] = [];
    for (const selection of selections) {
      try {
        callbacks.signal.throwIfAborted();
        const media = record.media.find((item) => item.index === selection.index);
        if (!media) throw new Error(t('dynamic.invalidRequest', {}, locale));
        callbacks.onProgress(t('content.mediaSaving', {}, locale));
        let mode = selection.mode;
        let blob: Blob;
        let filename: string;
        let fallbackWarning: string | undefined;
        if (mode === 'framed' && media.type !== 'photo') {
          const dynamic = await renderDynamic(request, [media], selection.orientation, callbacks);
          if (dynamic.blob) {
            blob = dynamic.blob;
            filename = buildFrameFilename(record, media, settings.filenameTemplate, 'mp4');
          } else {
            if (!dynamic.fallback?.blob)
              throw new Error(dynamic.fallback?.reason ?? t('dynamic.invalidResponse', {}, locale));
            fallbackWarning = t(
              'experiment.fallbackFrame',
              { reason: dynamic.fallback.reason },
              locale,
            );
            blob = dynamic.fallback.blob;
            mode = 'original';
            filename = buildMediaFilename(record, media, settings.filenameTemplate);
          }
        } else if (mode === 'framed') {
          blob = await renderPhotoFrame(
            record,
            media,
            settings.frameTemplate,
            selection.orientation,
            resources,
            request.theme,
            undefined,
            locale,
          );
          filename = buildFrameFilename(
            record,
            media,
            settings.filenameTemplate,
            extension(blob, locale) as 'jpg' | 'webp',
          );
        } else {
          callbacks.onProgress(t('dynamic.progress.downloading', {}, locale));
          blob = await fetchMedia(
            media,
            callbacks.signal,
            locale,
            mode === 'sourced' && media.type !== 'photo' ? 512 * 1024 * 1024 : 0,
          );
          if (mode === 'sourced' && media.type !== 'photo') {
            blob = await embedMp4SourceInWorker(
              blob,
              createMediaSourceMetadata(record, media, browser.runtime.getManifest().version),
              { signal: callbacks.signal, locale },
            );
            filename = buildSourcedMediaFilename(record, media, settings.filenameTemplate);
          } else {
            mode = 'original';
            filename = buildMediaFilename(record, media, settings.filenameTemplate);
          }
        }
        await emit(callbacks, {
          id: `${request.id}:media:${media.index}`,
          filename,
          blob,
          output: {
            tweetId: record.tweetId,
            outputType: outputType(media, mode),
            filename,
            mediaIndex: media.index,
          },
        });
        if (fallbackWarning) callbacks.onWarning(fallbackWarning);
      } catch (error) {
        if (callbacks.signal.aborted) throw error;
        failures.push(
          t(
            'content.itemFailure',
            {
              index: selection.index,
              error: error instanceof Error ? error.message : String(error),
            },
            locale,
          ),
        );
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  } finally {
    callbacks.signal.removeEventListener('abort', dispose);
    resources.dispose();
  }
}
