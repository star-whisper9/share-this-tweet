import {
  appendVideoDiagnostic,
  isVideoDiagnosticSample,
  type VideoDiagnosticsReport,
} from './video-report.js';
import type { VideoDiagnosticMetadata } from '../shared/video-render.js';
import type { TweetRecord, MediaRecord } from '../shared/model.js';
import type { ExtensionSettings } from '../shared/settings.js';
import { t, type Locale } from '../shared/i18n.js';
import type { ImageTheme } from './image-theme.js';
import type { FrameOrientation } from './frame.js';

export const VIDEO_PORT_NAME = 'stt-video-render';
export interface VideoRenderRequest {
  type: 'start';
  id: string;
  record: TweetRecord;
  indexes: number[];
  style: ExtensionSettings['stitchStyle'];
  frame: 'original' | FrameOrientation;
  frameTemplate: string;
  theme: ImageTheme;
  locale: Locale;
}
/** A declared processing limit was exceeded; unrelated failures never use this path. */
export class VideoLimitFallback extends Error {
  constructor(
    reason: string,
    public readonly originalBlob?: Blob,
  ) {
    super(reason);
    this.name = 'VideoLimitFallback';
  }
}
export interface VideoProgress {
  phase: 'downloading' | 'loading' | 'probing' | 'encoding';
  progress?: number;
}

/** Keep the extension background alive and bind cancellation to this exact job. */
export function renderDynamicMedia(
  record: TweetRecord,
  media: MediaRecord[],
  settings: ExtensionSettings,
  frame: 'original' | FrameOrientation,
  theme: ImageTheme,
  locale: Locale,
  options: {
    signal: AbortSignal;
    onProgress?: (progress: VideoProgress) => void;
    onDiagnostics?: (report: VideoDiagnosticsReport) => void;
  },
): Promise<Blob> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connect({ name: VIDEO_PORT_NAME });
    const id = crypto.randomUUID();
    const started = performance.now();
    const report: VideoDiagnosticsReport = {
      schemaVersion: 1,
      jobId: id,
      tweetId: record.tweetId,
      engine: { name: 'ffmpeg.wasm', coreVersion: '0.12.10', threading: 'single', gpu: false },
      startedAt: new Date().toISOString(),
      userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
      extensionVersion: browser.runtime.getManifest?.().version,
      status: 'running',
      elapsedMs: 0,
      mediaIndexes: media.map((item) => item.index),
      frame,
      style: settings.stitchStyle,
      samples: [],
      phaseDurationsMs: {},
      droppedSamples: 0,
      memoryMeasurement: 'wasm-linear-memory-capacity-and-memfs-files-not-process-rss',
    };
    options.onDiagnostics?.(report);
    let finished = false;
    let heartbeat: ReturnType<typeof setInterval>;
    const finish = (error?: unknown, blob?: Blob): void => {
      if (finished) return;
      finished = true;
      report.elapsedMs = performance.now() - started;
      report.finishedAt = new Date().toISOString();
      report.status = options.signal.aborted ? 'cancelled' : error || !blob ? 'error' : 'completed';
      if (error) report.error = error instanceof Error ? error.message : String(error);
      if (blob) report.resultBytes = blob.size;
      options.onDiagnostics?.(report);
      clearInterval(heartbeat);
      options.signal.removeEventListener('abort', abort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      if (error) reject(error);
      else if (blob) resolve(blob);
      else reject(new Error(t('dynamic.invalidResponse', {}, locale)));
    };
    const abort = () => finish(new Error(t('dynamic.cancelled', {}, locale)));
    const onDisconnect = () => finish(new Error(t('dynamic.disconnected', {}, locale)));
    const onMessage = (value: unknown): void => {
      if (!value || typeof value !== 'object')
        return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
      const message = value as {
        id?: unknown;
        type?: unknown;
        blob?: unknown;
        error?: unknown;
        phase?: unknown;
        progress?: unknown;
        sample?: unknown;
        metadata?: unknown;
        reason?: unknown;
      };
      if (message.id !== id) return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
      if (message.type === 'pong') return;
      if (message.type === 'fallback') {
        if (
          typeof message.reason !== 'string' ||
          (message.blob !== undefined && (!(message.blob instanceof Blob) || !message.blob.size))
        )
          return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
        return finish(new VideoLimitFallback(message.reason, message.blob as Blob | undefined));
      }
      if (message.type === 'diagnostics') {
        if (!isVideoDiagnosticSample(message.sample))
          return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
        const metadata = message.metadata;
        if (
          metadata !== undefined &&
          (!metadata ||
            typeof metadata !== 'object' ||
            !('inputBytes' in metadata) ||
            typeof metadata.inputBytes !== 'number' ||
            !Number.isFinite(metadata.inputBytes))
        )
          return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
        appendVideoDiagnostic(
          report,
          message.sample,
          performance.now() - started,
          metadata as VideoDiagnosticMetadata | undefined,
        );
        options.onDiagnostics?.(report);
      } else if (message.type === 'progress') {
        if (!['downloading', 'loading', 'probing', 'encoding'].includes(String(message.phase)))
          return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
        options.onProgress?.({
          phase: message.phase as VideoProgress['phase'],
          ...(typeof message.progress === 'number' && Number.isFinite(message.progress)
            ? { progress: Math.max(0, Math.min(1, message.progress)) }
            : {}),
        });
      } else if (
        message.type === 'done' &&
        message.blob instanceof Blob &&
        message.blob.type === 'video/mp4' &&
        message.blob.size
      )
        finish(undefined, message.blob);
      else if (message.type === 'error' && typeof message.error === 'string')
        finish(new Error(message.error));
      else finish(new Error(t('dynamic.invalidResponse', {}, locale)));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    options.signal.addEventListener('abort', abort, { once: true });
    heartbeat = setInterval(() => {
      try {
        port.postMessage({ type: 'ping', id });
      } catch (error) {
        finish(error);
      }
    }, 10_000);
    const request: VideoRenderRequest = {
      type: 'start',
      id,
      record,
      indexes: media.map((item) => item.index),
      style: settings.stitchStyle,
      frame,
      frameTemplate: settings.frameTemplate,
      theme,
      locale,
    };
    try {
      port.postMessage(request);
    } catch (error) {
      finish(error);
    }
  });
}
