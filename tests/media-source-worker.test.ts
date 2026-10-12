import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { embedGifSource } from '../src/core/gif-source.js';
import { embedMp4Source } from '../src/core/mp4-source.js';
import type { MediaSourceMetadata } from '../src/shared/media-source.js';

const source: MediaSourceMetadata = {
  schemaVersion: 1,
  platform: 'x',
  tweetId: '12345',
  tweetUrl: 'https://x.com/test/status/12345',
  publisher: { handle: '@test', name: 'Test' },
  media: { index: 1, type: 'animated_gif' },
  tool: { name: 'share-this-tweet', version: '0.5.3' },
};
const gif = new Blob([
  new Uint8Array([
    ...new TextEncoder().encode('GIF87a'),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    2,
    2,
    0x44,
    0x01,
    0,
    0x3b,
  ]),
]);
const postMessage = vi.fn();
const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void };
beforeAll(async () => {
  vi.stubGlobal('postMessage', postMessage);
  vi.stubGlobal('onmessage', null);
  await import('../src/workers/media-source.worker.js');
});
afterAll(() => vi.unstubAllGlobals());
async function read(blob: Blob): Promise<{ ok: boolean; result?: unknown }> {
  postMessage.mockClear();
  scope.onmessage({ data: { id: 'read', type: 'read', format: 'auto', blob } } as MessageEvent);
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
  return postMessage.mock.calls[0][0];
}

describe('media source worker format detection', () => {
  it('reads GIF and MP4 sources by signature regardless of MIME type', async () => {
    const sourcedGif = await embedGifSource(gif, source);
    expect(await read(new Blob([sourcedGif], { type: 'video/mp4' }))).toEqual({
      id: 'read',
      ok: true,
      result: source,
    });
    const mp4 = new Blob([readFileSync(new URL('./fixtures/source-media.mp4', import.meta.url))]);
    const sourcedMp4 = await embedMp4Source(mp4, source);
    expect(await read(new Blob([sourcedMp4], { type: 'image/gif' }))).toEqual({
      id: 'read',
      ok: true,
      result: source,
    });
    expect(await read(gif)).toEqual({ id: 'read', ok: true, result: undefined });
  });

  it('rejects fake MIME types and corrupt streams after a valid signature', async () => {
    for (const blob of [
      new Blob(['not media'], { type: 'image/gif' }),
      gif.slice(0, -1),
      new Blob(['1234ftyp']),
    ])
      expect(await read(blob)).toMatchObject({ id: 'read', ok: false });
  });
});
