import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderVideoInBackground } from '../src/background/video-render.js';
import { renderFrameStrip } from '../src/core/frame.js';
import type { BackgroundVideoRenderRequest } from '../src/shared/video-job.js';
import { loadSettings } from '../src/shared/settings.js';
vi.mock('../src/core/frame.js', async (original) => ({
  ...(await original<typeof import('../src/core/frame.js')>()),
  renderFrameStrip: vi.fn(),
}));
vi.mock('../src/shared/settings.js', () => ({ loadSettings: vi.fn() }));
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: unknown) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
const request: BackgroundVideoRenderRequest = {
  type: 'start',
  id: 'one',
  indexes: [1],
  style: 'gallery',
  frame: 'top',
  frameTemplate: '{author.name}',
  theme: 'light',
  locale: 'en',
  record: {
    tweetId: '42',
    url: 'https://x.com/a/status/42',
    text: '',
    author: { id: '1', name: 'A', handle: 'a' },
    media: [
      {
        index: 1,
        type: 'video',
        variants: [{ mime: 'video/mp4', url: 'https://video.twimg.com/a.mp4' }],
      },
    ],
  },
};
const jobs: Array<{
  controller: AbortController;
  promise: ReturnType<typeof renderVideoInBackground>;
}> = [];
function start(value = request) {
  const controller = new AbortController();
  const onProgress = vi.fn();
  const onDiagnostics = vi.fn();
  const promise = renderVideoInBackground(value, {
    signal: controller.signal,
    onProgress,
    onDiagnostics,
  });
  // Teardown cancels incomplete handshakes; attach a rejection handler immediately.
  void promise.catch(() => undefined);
  jobs.push({ controller, promise });
  return { controller, promise, onProgress, onDiagnostics };
}
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue({
    experimentalVideo: true,
    videoLimits: {
      maxInputMiB: 0,
      maxDurationSeconds: 0,
      maxOutputPixels: 0,
      maxFrameRate: 0,
    },
  } as Awaited<ReturnType<typeof loadSettings>>);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('browser', {
    runtime: { getURL: (path: string) => `moz-extension://test/${path}` },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  vi.mocked(renderFrameStrip).mockResolvedValue({
    blob: new Blob(['png'], { type: 'image/png' }),
    width: 64,
    height: 32,
  });
});
afterEach(async () => {
  for (const job of jobs) job.controller.abort();
  await Promise.allSettled(jobs.splice(0).map((job) => job.promise));
  FakeWorker.instances = [];
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('renders a frame after the real layout handshake and cleans up after output', async () => {
  const job = start();
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  worker.emit({
    type: 'diagnostics',
    id: 'one',
    sample: { phase: 'loading', workerElapsedMs: 1, phaseElapsedMs: 1 },
  });
  expect(job.onDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'diagnostics',
      metadata: { inputBytes: 3, downloadMs: expect.any(Number) },
    }),
  );
  worker.emit({ type: 'layout', id: 'one', width: 64, height: 32, duration: 1 });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
  expect(renderFrameStrip).toHaveBeenCalledWith(
    request.record,
    request.record.media[0],
    64,
    request.frameTemplate,
    expect.anything(),
    'light',
    'en',
  );
  const blob = new Blob(['mp4'], { type: 'video/mp4' });
  worker.emit({ type: 'done', id: 'one', blob, width: 64, height: 64, duration: 1 });
  await expect(job.promise).resolves.toEqual({ type: 'done', blob });
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it('rejects concurrent jobs and terminates the active worker on cancellation', async () => {
  const first = start();
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const second = start({ ...request, id: 'two' });
  await expect(second.promise).rejects.toThrow();
  expect(FakeWorker.instances).toHaveLength(1);
  first.controller.abort();
  await expect(first.promise).rejects.toThrow();
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
it('rejects dynamic jobs while the experimental switch is off', async () => {
  vi.mocked(loadSettings).mockResolvedValueOnce({
    experimentalVideo: false,
  } as Awaited<ReturnType<typeof loadSettings>>);
  const job = start();
  await expect(job.promise).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(FakeWorker.instances).toHaveLength(0);
});

it('runs GIF conversion independently of video framing and enforces the GIF switch', async () => {
  const gifRequest: BackgroundVideoRenderRequest = {
    ...request,
    frame: 'original',
    outputFormat: 'gif',
    record: { ...request.record, media: [{ ...request.record.media[0], type: 'animated_gif' }] },
  };
  vi.mocked(loadSettings).mockResolvedValueOnce({
    experimentalVideo: false,
    experimentalGif: true,
    gifLimits: { maxInputMiB: 64, maxDurationSeconds: 60, maxSourcePixels: 8294400 },
  } as Awaited<ReturnType<typeof loadSettings>>);
  const promise = renderVideoInBackground(gifRequest, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      outputFormat: 'gif',
      limits: {
        maxInputMiB: 64,
        maxDurationSeconds: 60,
        maxOutputPixels: 8294400,
        maxFrameRate: 0,
      },
    }),
  );
  const gif = new Blob(['gif'], { type: 'image/gif' });
  worker.emit({ type: 'done', id: request.id, blob: gif });
  expect(await promise).toEqual({ type: 'done', blob: gif });
  expect(worker.terminate).toHaveBeenCalledOnce();
  vi.mocked(loadSettings).mockResolvedValueOnce({
    experimentalVideo: true,
    experimentalGif: false,
  } as Awaited<ReturnType<typeof loadSettings>>);
  await expect(
    renderVideoInBackground(gifRequest, { signal: new AbortController().signal }),
  ).rejects.toThrow();
  expect(FakeWorker.instances).toHaveLength(1);
});
it('rejects unapproved hosts and incomplete downloads before starting FFmpeg', async () => {
  const bad = start({
    ...request,
    record: {
      ...request.record,
      media: [
        {
          index: 1,
          type: 'video',
          variants: [{ mime: 'video/mp4', url: 'https://example.com/a.mp4' }],
        },
      ],
    },
    indexes: [1],
  });
  await expect(bad.promise).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(new Uint8Array([1]), { headers: { 'content-length': '2' } }),
  );
  const big = start();
  await expect(big.promise).rejects.toThrow();
  expect(FakeWorker.instances).toHaveLength(0);
});

it('keeps a single source download for the original-media fallback when it crosses a limit', async () => {
  vi.mocked(loadSettings).mockResolvedValueOnce({
    experimentalVideo: true,
    videoLimits: {
      maxInputMiB: 0.000001,
      maxDurationSeconds: 0,
      maxOutputPixels: 0,
      maxFrameRate: 0,
    },
  } as Awaited<ReturnType<typeof loadSettings>>);
  const job = start();
  await expect(job.promise).resolves.toMatchObject({ type: 'fallback', blob: expect.any(Blob) });
  expect(FakeWorker.instances).toHaveLength(0);
});

it('turns a worker-reported limit into a fallback and reuses a single source blob', async () => {
  const job = start();
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  FakeWorker.instances[0]!.emit({
    type: 'error',
    id: 'one',
    error: 'configured limit exceeded',
    limitExceeded: true,
  });
  await expect(job.promise).resolves.toMatchObject({ type: 'fallback', blob: expect.any(Blob) });
  const fallback = await job.promise;
  expect(fallback.blob?.type).toBe('video/mp4');
});

it('accepts layout messages above the former dimensions and duration caps', async () => {
  const job = start({ ...request, frame: 'original' });
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  worker.emit({ type: 'layout', id: 'one', width: 4096, height: 2160, duration: 600 });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'frame', id: 'one' }),
  );
  const blob = new Blob(['mp4'], { type: 'video/mp4' });
  worker.emit({ type: 'done', id: request.id, blob });
  await expect(job.promise).resolves.toEqual({ type: 'done', blob });
});

it.each([true, false])(
  'stops an oversized collage download and returns a static fallback, declared size=%s',
  async (declaredSize) => {
    vi.mocked(loadSettings).mockResolvedValueOnce({
      experimentalVideo: true,
      videoLimits: {
        maxInputMiB: 1 / 1048576,
        maxDurationSeconds: 0,
        maxOutputPixels: 0,
        maxFrameRate: 0,
      },
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        new Uint8Array([1, 2, 3]),
        declaredSize ? { headers: { 'content-length': '3' } } : undefined,
      ),
    );
    const job = start({
      ...request,
      indexes: [1, 2],
      record: {
        ...request.record,
        media: [request.record.media[0]!, { ...request.record.media[0]!, index: 2 }],
      },
    });
    const result = await job.promise;
    expect(result).toMatchObject({ type: 'fallback' });
    expect(result.blob).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(0);
  },
);
