import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedMp4SourceInWorker, readMp4SourceInWorker } from '../src/core/media-source-client.js';
import type { MediaSourceMetadata } from '../src/shared/media-source.js';

const source: MediaSourceMetadata = {
  schemaVersion: 1,
  platform: 'x',
  tweetId: '12345',
  tweetUrl: 'https://x.com/test/status/12345',
  publisher: { handle: '@test', name: 'Test' },
  media: { index: 1, type: 'video' },
  tool: { name: 'share-this-tweet', version: '0.4.0' },
};
let workers: TestWorker[];
let postFailure: Error | undefined;
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_message: unknown) => {
    if (postFailure) throw postFailure;
  });
  constructor(readonly url: string) {
    workers.push(this);
  }
  reply(result: unknown, ok = true): void {
    const request = this.postMessage.mock.calls[0][0] as { id: string };
    this.onmessage?.({
      data: { id: request.id, ok, ...(ok ? { result } : { error: result }) },
    } as MessageEvent);
  }
}
beforeEach(() => {
  workers = [];
  postFailure = undefined;
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('browser', {
    runtime: { getURL: (path: string) => `moz-extension://local/${path}` },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('source Worker lifetime', () => {
  it('passes Blobs to an extension Worker and terminates after a validated result', async () => {
    const input = new Blob(['original']);
    const output = new Blob(['output'], { type: 'video/mp4' });
    const pending = embedMp4SourceInWorker(input, source);
    const worker = workers[0];
    expect(worker.url).toBe('moz-extension://local/workers/media-source.worker.js');
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
      type: 'embed',
      blob: input,
      source,
    });
    worker.reply(output);
    await expect(pending).resolves.toBe(output);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });

  it('distinguishes no source from malformed worker source data', async () => {
    const absent = readMp4SourceInWorker(new Blob());
    workers[0].reply(undefined);
    await expect(absent).resolves.toBeUndefined();
    const invalid = readMp4SourceInWorker(new Blob());
    workers[1].reply({ ...source, tweetUrl: 'javascript:1' });
    await expect(invalid).rejects.toThrow();
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('rejects worker errors, communication faults and invalid success responses', async () => {
    const failure = readMp4SourceInWorker(new Blob());
    workers[0].reply('failed', false);
    await expect(failure).rejects.toThrow();
    const communication = readMp4SourceInWorker(new Blob());
    workers[1].onmessageerror?.();
    await expect(communication).rejects.toThrow();
    const empty = embedMp4SourceInWorker(new Blob(), source);
    workers[2].reply(new Blob());
    await expect(empty).rejects.toThrow();
    const crash = readMp4SourceInWorker(new Blob());
    workers[3].onerror?.({
      message: 'worker crashed',
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);
    await expect(crash).rejects.toThrow();
    postFailure = new Error('could not clone');
    await expect(readMp4SourceInWorker(new Blob())).rejects.toThrow();
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('terminates on cancellation or timeout without leaving pending promises', async () => {
    const controller = new AbortController();
    const canceled = readMp4SourceInWorker(new Blob(), { signal: controller.signal });
    controller.abort();
    await expect(canceled).rejects.toThrow();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await expect(
      readMp4SourceInWorker(new Blob(), { signal: controller.signal }),
    ).rejects.toThrow();
    expect(workers).toHaveLength(1);
    vi.useFakeTimers();
    const timedOut = expect(readMp4SourceInWorker(new Blob(), { timeoutMs: 10 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
