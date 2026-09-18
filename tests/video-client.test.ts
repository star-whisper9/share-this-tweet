import { afterEach, expect, it, vi } from 'vitest';
import { renderDynamicMedia, VideoLimitFallback } from '../src/core/video-client.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { TweetRecord } from '../src/shared/model.js';

function port() {
  const messages = new Set<(value: unknown) => void>();
  const disconnects = new Set<() => void>();
  return {
    messages,
    disconnects,
    name: 'stt-video-render',
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn: (value: unknown) => void) => messages.add(fn),
      removeListener: (fn: (value: unknown) => void) => messages.delete(fn),
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnects.add(fn),
      removeListener: (fn: () => void) => disconnects.delete(fn),
    },
    receive(value: unknown) {
      for (const fn of messages) fn(value);
    },
  };
}
const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/a/status/42',
  text: '',
  author: { id: '1', name: 'A', handle: 'a' },
  media: [{ index: 1, type: 'video' }],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('routes progress and returns only validated MP4 blobs, then disconnects', async () => {
  const connection = port();
  vi.stubGlobal('browser', { runtime: { connect: () => connection } });
  const onProgress = vi.fn();
  const onDiagnostics = vi.fn();
  const job = renderDynamicMedia(record, record.media, DEFAULT_SETTINGS, 'top', 'dark', 'en', {
    signal: new AbortController().signal,
    onProgress,
    onDiagnostics,
  });
  const request = connection.postMessage.mock.calls[0][0];
  expect(request).toMatchObject({ indexes: [1], frame: 'top', locale: 'en' });
  connection.receive({ type: 'progress', id: request.id, phase: 'encoding', progress: 0.5 });
  expect(onProgress).toHaveBeenCalledWith({ phase: 'encoding', progress: 0.5 });
  connection.receive({
    type: 'diagnostics',
    id: request.id,
    sample: {
      phase: 'encoding',
      workerElapsedMs: 2000,
      phaseElapsedMs: 1800,
      frames: 54,
      encodedSeconds: 2,
      speed: 1,
      wasmCapacityBytes: 64 * 1024 * 1024,
    },
    metadata: {
      inputBytes: 1234,
      downloadMs: 200,
      output: { width: 720, height: 1378, duration: 135.7, frameRate: 27 },
    },
  });
  const blob = new Blob(['video'], { type: 'video/mp4' });
  connection.receive({ type: 'done', id: request.id, blob });
  await expect(job).resolves.toBe(blob);
  expect(connection.disconnect).toHaveBeenCalledOnce();
  expect(connection.messages.size).toBe(0);
  const report = onDiagnostics.mock.lastCall![0];
  expect(report).toMatchObject({
    status: 'completed',
    resultBytes: blob.size,
    metadata: { inputBytes: 1234, downloadMs: 200 },
    engine: { gpu: false, threading: 'single' },
  });
  expect(report.samples).toHaveLength(1);
  expect(report.samples[0]).toMatchObject({ frames: 54, phase: 'encoding' });
  expect(report.finishedAt).toBeDefined();
});
it('disconnects cancelled jobs and rejects mismatched responses without accepting data', async () => {
  const connection = port();
  vi.stubGlobal('browser', { runtime: { connect: () => connection } });
  const controller = new AbortController();
  const job = renderDynamicMedia(
    record,
    record.media,
    DEFAULT_SETTINGS,
    'original',
    'light',
    'zh-CN',
    { signal: controller.signal },
  );
  const rejected = expect(job).rejects.toThrow();
  controller.abort();
  await rejected;
  expect(connection.disconnect).toHaveBeenCalledOnce();
  const next = port();
  vi.stubGlobal('browser', { runtime: { connect: () => next } });
  const invalid = renderDynamicMedia(
    record,
    record.media,
    DEFAULT_SETTINGS,
    'original',
    'light',
    'zh-CN',
    { signal: new AbortController().signal },
  );
  const failed = expect(invalid).rejects.toThrow();
  next.receive({
    type: 'done',
    id: 'another-job',
    blob: new Blob(['video'], { type: 'video/mp4' }),
  });
  await failed;
  expect(next.disconnect).toHaveBeenCalledOnce();
});

it('propagates typed limit fallbacks and releases the processing port', async () => {
  const connection = port();
  vi.stubGlobal('browser', { runtime: { connect: () => connection } });
  const job = renderDynamicMedia(record, record.media, DEFAULT_SETTINGS, 'bottom', 'dark', 'en', {
    signal: new AbortController().signal,
  });
  const rejected = expect(job).rejects.toBeInstanceOf(VideoLimitFallback);
  const id = connection.postMessage.mock.calls[0][0].id;
  const blob = new Blob(['original'], { type: 'video/mp4' });
  connection.receive({ type: 'fallback', id, reason: 'limit', blob });
  await rejected;
  await expect(job).rejects.toMatchObject({ originalBlob: blob });
  expect(connection.disconnect).toHaveBeenCalledOnce();
});
