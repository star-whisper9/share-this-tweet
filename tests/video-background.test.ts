import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleVideoPort, renderVideoInBackground } from '../src/background/video-render.js';
import { renderFrameStrip } from '../src/core/frame.js';
import type { VideoRenderRequest } from '../src/core/video-client.js';
import { loadSettings } from '../src/shared/settings.js';
vi.mock('../src/core/frame.js', async (original) => ({
  ...(await original<typeof import('../src/core/frame.js')>()),
  renderFrameStrip: vi.fn(),
}));
vi.mock('../src/shared/settings.js', () => ({ loadSettings: vi.fn() }));
class Port {
  name = 'stt-video-render';
  messages = new Set<(message: unknown) => void>();
  disconnects = new Set<() => void>();
  postMessage = vi.fn();
  onMessage = {
    addListener: (fn: (value: unknown) => void) => this.messages.add(fn),
    removeListener: (fn: (value: unknown) => void) => this.messages.delete(fn),
  };
  onDisconnect = {
    addListener: (fn: () => void) => this.disconnects.add(fn),
    removeListener: (fn: () => void) => this.disconnects.delete(fn),
  };
  receive(message: unknown) {
    for (const fn of this.messages) fn(message);
  }
  disconnect() {
    for (const fn of [...this.disconnects]) fn();
  }
}
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
const request: VideoRenderRequest = {
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
const ports: Port[] = [];
function start(value = request) {
  const port = new Port();
  ports.push(port);
  handleVideoPort(port);
  port.receive(value);
  return port;
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
afterEach(() => {
  for (const port of ports.splice(0)) port.disconnect();
  FakeWorker.instances = [];
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('renders a frame after the real layout handshake and cleans up after output', async () => {
  const port = start();
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  worker.emit({
    type: 'diagnostics',
    id: 'one',
    sample: { phase: 'loading', workerElapsedMs: 1, phaseElapsedMs: 1 },
  });
  expect(port.postMessage).toHaveBeenCalledWith(
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
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'done', id: 'one', blob }),
  );
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it('rejects concurrent jobs and terminates the active worker on disconnect', async () => {
  const first = start();
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const second = start({ ...request, id: 'two' });
  await vi.waitFor(() =>
    expect(second.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', id: 'two' }),
    ),
  );
  expect(FakeWorker.instances).toHaveLength(1);
  first.disconnect();
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
it('returns a static-fallback result when a multi-media input crosses a limit', async () => {
  vi.mocked(loadSettings).mockResolvedValueOnce({
    experimentalVideo: true,
    videoLimits: {
      maxInputMiB: 0.000001,
      maxDurationSeconds: 0,
      maxOutputPixels: 0,
      maxFrameRate: 0,
    },
  } as Awaited<ReturnType<typeof loadSettings>>);
  const result = await renderVideoInBackground(
    {
      ...request,
      indexes: [1, 2],
      record: {
        ...request.record,
        media: [
          request.record.media[0]!,
          {
            index: 2,
            type: 'animated_gif',
            variants: [{ mime: 'video/mp4', url: 'https://video.twimg.com/b.mp4' }],
          },
        ],
      },
    },
    { signal: new AbortController().signal },
  );
  expect(result.type).toBe('fallback');
  expect(FakeWorker.instances).toHaveLength(0);
});
it('rejects dynamic jobs while the experimental switch is off', async () => {
  vi.mocked(loadSettings).mockResolvedValueOnce({
    experimentalVideo: false,
  } as Awaited<ReturnType<typeof loadSettings>>);
  const port = start();
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(FakeWorker.instances).toHaveLength(0);
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
  await vi.waitFor(() =>
    expect(bad.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
  );
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(new Uint8Array([1]), { headers: { 'content-length': '2' } }),
  );
  const big = start();
  await vi.waitFor(() =>
    expect(big.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
  );
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
  const port = start();
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fallback', blob: expect.any(Blob) }),
    ),
  );
  expect(FakeWorker.instances).toHaveLength(0);
});

it('turns a worker-reported limit into a fallback and reuses a single source blob', async () => {
  const port = start();
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  FakeWorker.instances[0]!.emit({
    type: 'error',
    id: 'one',
    error: 'configured limit exceeded',
    limitExceeded: true,
  });
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fallback', blob: expect.any(Blob) }),
    ),
  );
  const fallback = port.postMessage.mock.calls.find(
    ([message]) => message.type === 'fallback',
  )![0] as {
    blob: Blob;
  };
  expect(fallback.blob.type).toBe('video/mp4');
});

it('accepts layout messages above the former dimensions and duration caps', async () => {
  const port = start({ ...request, frame: 'original' });
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  worker.emit({ type: 'layout', id: 'one', width: 4096, height: 2160, duration: 600 });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'frame', id: 'one' }),
  );
  expect(port.postMessage.mock.calls.some(([message]) => message.type === 'error')).toBe(false);
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
    const port = start({
      ...request,
      indexes: [1, 2],
      record: {
        ...request.record,
        media: [request.record.media[0]!, { ...request.record.media[0]!, index: 2 }],
      },
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'fallback' })),
    );
    const message = port.postMessage.mock.calls.find(([value]) => value.type === 'fallback')![0];
    expect(message.blob).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(0);
  },
);
