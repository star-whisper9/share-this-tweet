import { afterEach, expect, it, vi } from 'vitest';
import { renderDynamicMedia } from '../src/core/video-client.js';
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
  const job = renderDynamicMedia(record, record.media, DEFAULT_SETTINGS, 'top', 'dark', 'en', {
    signal: new AbortController().signal,
    onProgress,
  });
  const request = connection.postMessage.mock.calls[0][0];
  expect(request).toMatchObject({ indexes: [1], frame: 'top', locale: 'en' });
  connection.receive({ type: 'progress', id: request.id, phase: 'encoding', progress: 0.5 });
  expect(onProgress).toHaveBeenCalledWith({ phase: 'encoding', progress: 0.5 });
  const blob = new Blob(['video'], { type: 'video/mp4' });
  connection.receive({ type: 'done', id: request.id, blob });
  await expect(job).resolves.toBe(blob);
  expect(connection.disconnect).toHaveBeenCalledOnce();
  expect(connection.messages.size).toBe(0);
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
