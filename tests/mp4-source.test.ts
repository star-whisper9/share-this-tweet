import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  embedMp4Source,
  readMp4Source,
  MAX_MP4_SOURCE_FILE_BYTES,
} from '../src/core/mp4-source.js';
import type { MediaSourceMetadata } from '../src/shared/media-source.js';

const fixture = new Uint8Array(
  readFileSync(new URL('./fixtures/source-media.mp4', import.meta.url)),
);
const source: MediaSourceMetadata = {
  schemaVersion: 1,
  platform: 'x',
  tweetId: '12345',
  tweetUrl: 'https://x.com/test/status/12345',
  publisher: { id: '9876', handle: '@test', name: '来源发布者' },
  media: { index: 1, type: 'video' },
  tool: { name: 'share-this-tweet', version: '0.4.0' },
};
interface Atom {
  type: string;
  start: number;
  end: number;
  header: number;
}
const containers = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'dinf',
  'edts',
  'udta',
  'meta',
  'ilst',
]);
function atoms(bytes: Uint8Array, start = 0, end = bytes.length): Atom[] {
  const result: Atom[] = [];
  while (start < end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(start);
    const size =
      length === 1 ? Number(view.getBigUint64(start + 8)) : length === 0 ? end - start : length;
    result.push({
      type: String.fromCharCode(...bytes.subarray(start + 4, start + 8)),
      start,
      end: start + size,
      header: length === 1 ? 16 : 8,
    });
    start += size;
  }
  return result;
}
function atom(type: string, parts: Uint8Array[], extended = false): Uint8Array<ArrayBuffer> {
  const header = extended ? 16 : 8;
  const size = header + parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  view.setUint32(0, extended ? 1 : size);
  if (extended) view.setBigUint64(8, BigInt(size));
  for (let i = 0; i < 4; i++) output[4 + i] = type.charCodeAt(i);
  let offset = header;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function find(bytes: Uint8Array, path: string[]): Atom {
  let choices = atoms(bytes);
  let found: Atom | undefined;
  for (const type of path) {
    found = choices.find((item) => item.type === type)!;
    if (!found) throw new Error(`Missing fixture atom ${type}`);
    if (containers.has(type))
      choices = atoms(bytes, found.start + found.header + (type === 'meta' ? 4 : 0), found.end);
  }
  return found!;
}
function raw(bytes: Uint8Array, path: string[]): Uint8Array {
  const item = find(bytes, path);
  return bytes.slice(item.start, item.end);
}
function mapTree(
  bytes: Uint8Array,
  transform: (type: string, body: Uint8Array) => Uint8Array,
  rename: (type: string) => string = (type) => type,
): Uint8Array<ArrayBuffer> {
  return concat(
    atoms(bytes).map((item) => {
      const body = bytes.subarray(item.start + item.header, item.end);
      const skip = item.type === 'meta' ? 4 : 0;
      const mapped = containers.has(item.type)
        ? concat([body.subarray(0, skip), mapTree(body.subarray(skip), transform, rename)])
        : body;
      return atom(rename(item.type), [transform(item.type, mapped)]);
    }),
  );
}
function rewriteMovie(
  bytes: Uint8Array,
  transform: (type: string, body: Uint8Array) => Uint8Array,
  rename?: (type: string) => string,
): Uint8Array<ArrayBuffer> {
  const old = find(bytes, ['moov']);
  let movie = mapTree(bytes.subarray(old.start, old.end), transform, rename);
  const delta = movie.length - (old.end - old.start);
  movie = mapTree(movie, (type, body) => {
    if (type !== 'stco' && type !== 'co64') return body;
    const output = new Uint8Array(body);
    const view = new DataView(output.buffer);
    const count = view.getUint32(4);
    const width = type === 'stco' ? 4 : 8;
    for (let i = 0; i < count; i++) {
      const offset =
        type === 'stco' ? view.getUint32(8 + width * i) : Number(view.getBigUint64(8 + width * i));
      if (offset > old.end) {
        if (type === 'stco') view.setUint32(8 + width * i, offset + delta);
        else view.setBigUint64(8 + width * i, BigInt(offset + delta));
      }
    }
    return output;
  });
  return concat([bytes.subarray(0, old.start), movie, bytes.subarray(old.end)]);
}
function tailMovie(
  bytes: Uint8Array,
  extended = false,
  eofLength = false,
): Uint8Array<ArrayBuffer> {
  const moov = find(bytes, ['moov']);
  const free = atom('free', [bytes.subarray(moov.start + moov.header, moov.end)]);
  const moved = atom('moov', [bytes.subarray(moov.start + moov.header, moov.end)], extended);
  if (eofLength) new DataView(moved.buffer).setUint32(0, 0);
  return concat([bytes.subarray(0, moov.start), free, bytes.subarray(moov.end), moved]);
}
async function outputBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}
function input(bytes: Uint8Array = fixture): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
}

describe('MP4 file provenance', () => {
  it('round-trips sources while preserving media position, tracks, and existing metadata', async () => {
    expect(await readMp4Source(input())).toBeUndefined();
    const result = await embedMp4Source(input(), source);
    expect(await readMp4Source(result)).toEqual(source);
    const bytes = await outputBytes(result);
    expect(raw(bytes, ['mdat'])).toEqual(raw(fixture, ['mdat']));
    expect(find(bytes, ['mdat']).start).toBe(find(fixture, ['mdat']).start);
    expect(raw(bytes, ['moov', 'trak'])).toEqual(raw(fixture, ['moov', 'trak']));
    expect(raw(bytes, ['moov', 'udta', 'meta'])).toEqual(raw(fixture, ['moov', 'udta', 'meta']));
    expect(await embedMp4Source(result, source)).toBe(result);
    await expect(
      embedMp4Source(result, { ...source, media: { index: 2, type: 'video' } }),
    ).rejects.toMatchObject({ code: 'source-conflict' });
  });

  it.each([
    { extended: false, eof: false },
    { extended: true, eof: false },
    { extended: false, eof: true },
  ])(
    'handles movie indexes at EOF with explicit, extended, or EOF length: %j',
    async ({ extended, eof }) => {
      const original = tailMovie(fixture, extended, eof);
      const bytes = await outputBytes(await embedMp4Source(input(original), source));
      expect(await readMp4Source(input(bytes))).toEqual(source);
      expect(find(bytes, ['moov']).start).toBe(find(original, ['moov']).start);
      expect(raw(bytes, ['mdat'])).toEqual(raw(original, ['mdat']));
    },
  );

  it('normalizes an EOF-length mdat without absorbing appended provenance', async () => {
    const original = new Uint8Array(fixture);
    const media = find(original, ['mdat']);
    expect(media.end).toBe(original.length);
    new DataView(original.buffer).setUint32(media.start, 0);
    const result = await outputBytes(await embedMp4Source(input(original), source));
    expect(await readMp4Source(input(result))).toEqual(source);
    expect(raw(result, ['mdat'])).toEqual(raw(fixture, ['mdat']));
  });

  it('preserves co64 offsets and rejects offsets outside media data', async () => {
    const converted = rewriteMovie(
      fixture,
      (type, body) => {
        if (type !== 'stco') return body;
        const count = new DataView(body.buffer, body.byteOffset).getUint32(4);
        const output = new Uint8Array(8 + count * 8);
        output.set(body.subarray(0, 8));
        const view = new DataView(output.buffer);
        for (let i = 0; i < count; i++)
          view.setBigUint64(
            8 + i * 8,
            BigInt(new DataView(body.buffer, body.byteOffset).getUint32(8 + i * 4)),
          );
        return output;
      },
      (type) => (type === 'stco' ? 'co64' : type),
    );
    const result = await outputBytes(await embedMp4Source(input(converted), source));
    expect(raw(result, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'co64'])).toEqual(
      raw(converted, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'co64']),
    );
    expect(raw(result, ['mdat'])).toEqual(raw(converted, ['mdat']));
    const invalidOffset = new Uint8Array(fixture);
    const offsets = find(invalidOffset, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
    new DataView(invalidOffset.buffer).setUint32(offsets.start + offsets.header + 8, 1);
    await expect(embedMp4Source(input(invalidOffset), source)).rejects.toMatchObject({
      code: 'unsupported-mp4',
    });
  });

  it('distinguishes invalid files, unsupported structures, and absent metadata', async () => {
    await expect(
      readMp4Source(input(fixture.subarray(0, fixture.length - 1))),
    ).rejects.toMatchObject({ code: 'invalid-mp4' });
    await expect(readMp4Source(input(concat([fixture, atom('moof', [])])))).rejects.toMatchObject({
      code: 'unsupported-mp4',
    });
    const external = new Uint8Array(fixture);
    const dref = find(external, ['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref']);
    new DataView(external.buffer).setUint32(dref.start + dref.header + 8 + 8, 0);
    await expect(embedMp4Source(input(external), source)).rejects.toMatchObject({
      code: 'unsupported-mp4',
    });
    const indexed = rewriteMovie(fixture, (type, body) =>
      type === 'udta' ? concat([body, atom('iloc', [new Uint8Array(8)])]) : body,
    );
    await expect(readMp4Source(input(indexed))).rejects.toMatchObject({ code: 'unsupported-mp4' });
    const oversized = input();
    Object.defineProperty(oversized, 'size', { value: MAX_MP4_SOURCE_FILE_BYTES + 1 });
    await expect(readMp4Source(oversized)).rejects.toMatchObject({ code: 'unsupported-mp4' });
  });

  it('rejects duplicate or invalid embedded records instead of choosing one', async () => {
    const sourced = await outputBytes(await embedMp4Source(input(), source));
    const duplicate = rewriteMovie(sourced, (type, body) =>
      type === 'udta' ? concat([body, raw(sourced, ['moov', 'udta', 'uuid'])]) : body,
    );
    await expect(readMp4Source(input(duplicate))).rejects.toMatchObject({
      code: 'source-conflict',
    });
    const unknownVersion = rewriteMovie(sourced, (type, body) => {
      if (type !== 'uuid') return body;
      const json = new TextDecoder()
        .decode(body.subarray(16))
        .replace('"schemaVersion":1', '"schemaVersion":2');
      return concat([body.subarray(0, 16), new TextEncoder().encode(json)]);
    });
    await expect(readMp4Source(input(unknownVersion))).rejects.toMatchObject({
      code: 'invalid-source',
    });
  });

  it('only reads headers and the movie index from a large media Blob', async () => {
    const media = find(fixture, ['mdat']);
    const length = media.end - media.start + 16 * 1024 * 1024;
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, length);
    header.set(new TextEncoder().encode('mdat'), 4);
    const reads: number[] = [];
    class ObservedBlob extends Blob {
      override slice(start?: number, end?: number, type?: string): Blob {
        const part = super.slice(start, end, type);
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = () => {
          reads.push(part.size);
          return read();
        };
        return part;
      }
    }
    const large = new ObservedBlob([
      fixture.subarray(0, media.start),
      header,
      fixture.subarray(media.start + 8),
      new Uint8Array(16 * 1024 * 1024),
    ]);
    const result = await embedMp4Source(large, source);
    expect(result.size).toBeGreaterThan(16 * 1024 * 1024);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(64 * 1024);
  });
});
