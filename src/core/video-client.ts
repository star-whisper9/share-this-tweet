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
  options: { signal: AbortSignal; onProgress?: (progress: VideoProgress) => void },
): Promise<Blob> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connect({ name: VIDEO_PORT_NAME });
    const id = crypto.randomUUID();
    let finished = false;
    let heartbeat: ReturnType<typeof setInterval>;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown, blob?: Blob): void => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
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
      };
      if (message.id !== id) return finish(new Error(t('dynamic.invalidResponse', {}, locale)));
      if (message.type === 'pong') return;
      if (message.type === 'progress') {
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
    timer = setTimeout(() => finish(new Error(t('dynamic.timeout', {}, locale))), 300_000);
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
