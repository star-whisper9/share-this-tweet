import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleVideoPort } from '../src/background/video-render.js';
import { renderFrameStrip } from '../src/core/frame.js';
import type { VideoRenderRequest } from '../src/core/video-client.js';
vi.mock('../src/core/frame.js', async (original) => ({
  ...(await original<typeof import('../src/core/frame.js')>()),
  renderFrameStrip: vi.fn(),
}));
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
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'done', id: 'one', blob });
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
it('rejects unapproved hosts before downloading and oversized input before starting FFmpeg', async () => {
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
    new Response(new Uint8Array([1]), { headers: { 'content-length': String(65 * 1024 * 1024) } }),
  );
  const big = start();
  await vi.waitFor(() =>
    expect(big.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
  );
  expect(FakeWorker.instances).toHaveLength(0);
});
