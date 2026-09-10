import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embedMp4SourceInWorker = vi.fn(
  async (blob: Blob) => new Blob([blob, 'source'], { type: 'video/mp4' }),
);

vi.mock('../src/core/media-source-client.js', () => ({ embedMp4SourceInWorker }));

const source = {
  schemaVersion: 1 as const,
  platform: 'x' as const,
  tweetId: '42',
  tweetUrl: 'https://x.com/alice/status/42',
  publisher: { id: '7', handle: '@alice', name: 'Alice' },
  media: { index: 1, type: 'video' as const },
  tool: { name: 'share-this-tweet' as const, version: '0.4.0' },
};

describe('background sourced downloads', () => {
  let onMessage: (message: unknown) => unknown;
  let onChanged: (delta: unknown) => void;
  const download = vi.fn(async () => 9);
  const search = vi.fn(async () => [{ id: 9, state: 'complete' }]);

  beforeEach(async () => {
    vi.resetModules();
    download.mockClear();
    search.mockClear();
    embedMp4SourceInWorker.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    vi.stubGlobal('browser', {
      runtime: {
        getURL: (path: string) => `moz-extension://test/${path}`,
        onMessage: { addListener: (listener: typeof onMessage) => (onMessage = listener) },
      },
      downloads: {
        download,
        search,
        onChanged: { addListener: (listener: typeof onChanged) => (onChanged = listener) },
      },
    });
    await import('../src/background/background.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for a completed browser download and releases its object URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const response = await onMessage({
      type: 'download-sourced-media',
      url: 'https://video.twimg.com/test.mp4',
      filename: 'test_source.mp4',
      source,
    });
    expect(response).toEqual({ ok: true, downloadId: 9 });
    expect(search).toHaveBeenCalledWith({ id: 9 });
    expect(embedMp4SourceInWorker).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });

  it('keeps the request alive until a later completion event', async () => {
    search.mockResolvedValueOnce([{ id: 9, state: 'in_progress' }]);
    let settled = false;
    const pending = Promise.resolve(
      onMessage({
        type: 'download-sourced-media',
        url: 'https://video.twimg.com/test.mp4',
        filename: 'test_source.mp4',
        source,
      }),
    ).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    expect(settled).toBe(false);
    onChanged({ id: 9, state: { current: 'complete' } });
    await expect(pending).resolves.toEqual({ ok: true, downloadId: 9 });
  });

  it('reports an interrupted save, releases the Blob URL, and does not retry the original URL', async () => {
    search.mockResolvedValueOnce([{ id: 9, state: 'in_progress' }]);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const pending = Promise.resolve(
      onMessage({
        type: 'download-sourced-media',
        url: 'https://video.twimg.com/test.mp4',
        filename: 'test_source.mp4',
        source,
      }),
    );
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    onChanged({
      id: 9,
      state: { current: 'interrupted' },
      error: { current: 'USER_CANCELED' },
    });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toMatchObject({ url: expect.stringMatching(/^blob:/) });
    expect(revoke).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });

  it('does not start a browser download when the Worker fails', async () => {
    embedMp4SourceInWorker.mockRejectedValueOnce(new Error('unsupported MP4'));
    await expect(
      onMessage({
        type: 'download-sourced-media',
        url: 'https://video.twimg.com/test.mp4',
        filename: 'test_source.mp4',
        source,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(download).not.toHaveBeenCalled();
  });

  it('enforces its byte limit while streaming a response without content-length', async () => {
    const { readBoundedResponse } = await import('../src/background/background.js');
    await expect(
      readBoundedResponse(new Response(new Uint8Array([1, 2, 3, 4])), 3),
    ).rejects.toThrow();
  });

  it('uses Unicode code points when validating existing filenames', async () => {
    const { validateDownloadRequest } = await import('../src/background/background.js');
    expect(
      validateDownloadRequest('https://video.twimg.com/test.mp4', `${'😀'.repeat(120)}.mp4`),
    ).toBeUndefined();
  });
});
