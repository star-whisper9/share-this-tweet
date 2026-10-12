import { describe, expect, it } from 'vitest';
import { embedGifSource, GIF_SOURCE_APPLICATION, readGifSource } from '../src/core/gif-source.js';
import { MAX_MEDIA_SOURCE_BYTES, type MediaSourceMetadata } from '../src/shared/media-source.js';
import { MAX_MP4_SOURCE_FILE_BYTES } from '../src/core/mp4-source.js';

const source: MediaSourceMetadata = {
  schemaVersion: 1,
  platform: 'x',
  tweetId: '12345',
  tweetUrl: 'https://x.com/test/status/12345',
  publisher: { handle: '@test', name: '来源发布者' },
  media: { index: 1, type: 'animated_gif' },
  tool: { name: 'share-this-tweet', version: '0.5.3' },
};
const encoder = new TextEncoder();
// Two 1x1 frames, a two-color global table, 100 ms delays, and an infinite loop.
const header = new Uint8Array([
  ...encoder.encode('GIF89a'),
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
]);
const frame = new Uint8Array([
  0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
]);
const loop = new Uint8Array([0x21, 0xff, 11, ...encoder.encode('NETSCAPE2.0'), 3, 1, 0, 0, 0]);
function input(...parts: BlobPart[]): Blob {
  return new Blob(parts.length ? parts : [header, loop, frame, frame, new Uint8Array([0x3b])], {
    type: 'image/gif',
  });
}
function extension(data: Uint8Array, application = GIF_SOURCE_APPLICATION): Blob {
  const parts: BlobPart[] = [new Uint8Array([0x21, 0xff, 11]), encoder.encode(application)];
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = new Uint8Array(data.subarray(offset, offset + 255));
    parts.push(new Uint8Array([chunk.length]), chunk);
  }
  return new Blob([...parts, new Uint8Array([0])]);
}

describe('GIF provenance', () => {
  it('preserves all animation bytes and round-trips UTF-8 provenance', async () => {
    const original = input();
    expect(await readGifSource(original)).toBeUndefined();
    const result = await embedGifSource(original, source);
    expect(result.type).toBe('image/gif');
    expect(await readGifSource(result)).toEqual(source);
    const bytes = new Uint8Array(await original.arrayBuffer());
    expect(new Uint8Array(await result.slice(0, bytes.length - 1).arrayBuffer())).toEqual(
      bytes.subarray(0, bytes.length - 1),
    );
    expect(new Uint8Array(await result.slice(-1).arrayBuffer())).toEqual(new Uint8Array([0x3b]));
    expect(await embedGifSource(result, source)).toBe(result);
    await expect(
      embedGifSource(result, { ...source, media: { index: 2, type: 'animated_gif' } }),
    ).rejects.toMatchObject({ code: 'source-conflict' });
  });

  it('upgrades GIF87a only in the header when introducing the extension', async () => {
    const original = input('GIF87a', header.slice(6), frame.slice(8), new Uint8Array([0x3b]));
    const result = await embedGifSource(original, source);
    expect(await readGifSource(result)).toEqual(source);
    expect(await result.slice(0, 6).text()).toBe('GIF89a');
    expect(new Uint8Array(await result.slice(6, original.size - 1).arrayBuffer())).toEqual(
      new Uint8Array(await original.slice(6, -1).arrayBuffer()),
    );
  });

  it('rejects duplicate sources, invalid UTF-8, unsafe URLs, and oversized raw metadata', async () => {
    const json = encoder.encode(JSON.stringify(source));
    for (const [parts, code] of [
      [[extension(json), extension(json)], 'source-conflict'],
      [[extension(new Uint8Array([0xff]))], 'invalid-source'],
      [
        [extension(encoder.encode(JSON.stringify({ ...source, tweetUrl: 'javascript:1' })))],
        'invalid-source',
      ],
      [[extension(new Uint8Array(MAX_MEDIA_SOURCE_BYTES + 1))], 'invalid-source'],
    ] as const) {
      await expect(
        readGifSource(input(header, frame, ...parts, new Uint8Array([0x3b]))),
      ).rejects.toMatchObject({ code });
    }
  });

  it('requires a complete GIF stream and never scans payloads for source markers', async () => {
    const embeddedMarker = extension(encoder.encode(JSON.stringify(source)));
    const markerBytes = new Uint8Array(await embeddedMarker.arrayBuffer());
    // Application bytes inside an ordinary comment are data, not nested extensions.
    const comment = new Blob([new Uint8Array([0x21, 0xfe]), extension(markerBytes).slice(14)]);
    expect(
      await readGifSource(input(header, comment, frame, new Uint8Array([0x3b]))),
    ).toBeUndefined();
    const original = input();
    const badFrame = new Uint8Array(frame);
    badFrame[frame.length - 4] = 255; // Declared image sub-block overruns the file.
    const invalids = [
      original.slice(0, -1),
      new Blob([original, 'trailing']),
      input(header, badFrame, new Uint8Array([0x3b])),
      input(header, new Uint8Array([0x21, 0xff, 10]), markerBytes, frame, new Uint8Array([0x3b])),
      input(
        header,
        frame,
        extension(encoder.encode(JSON.stringify(source))),
        new Uint8Array([0x2c]),
      ),
      new Blob(['not a gif'], { type: 'image/gif' }),
    ];
    for (const invalid of invalids)
      await expect(readGifSource(invalid)).rejects.toMatchObject({ code: 'invalid-gif' });
    const oversized = input();
    Object.defineProperty(oversized, 'size', { value: MAX_MP4_SOURCE_FILE_BYTES + 1 });
    await expect(readGifSource(oversized)).rejects.toMatchObject({ code: 'unsupported-gif' });
  });
});
