import {
  MAX_MEDIA_SOURCE_BYTES,
  parseMediaSourceMetadata,
  type MediaSourceMetadata,
} from '../shared/media-source.js';
import { t } from '../shared/i18n.js';
import { MAX_MP4_SOURCE_FILE_BYTES } from './mp4-source.js';

// GIF89a Application Extension: 8-byte application identifier + 3-byte auth code.
// The data sub-blocks contain the same UTF-8 JSON provenance schema as MP4.
export const GIF_SOURCE_APPLICATION = 'STTSOURCE01';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class GifSourceError extends Error {
  constructor(
    public readonly code: 'invalid-gif' | 'unsupported-gif' | 'invalid-source' | 'source-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'GifSourceError';
  }
}

function invalid(): never {
  throw new GifSourceError('invalid-gif', t('core.gif.invalid'));
}

/** Bounded reads; image payloads are skipped using their declared sub-block sizes. */
class Reader {
  position = 0;
  private start = 0;
  private bytes = new Uint8Array(0);
  constructor(readonly input: Blob) {}

  skip(length: number): void {
    if (length < 0 || this.position + length > this.input.size) invalid();
    this.position += length;
  }

  private async fill(): Promise<void> {
    this.start = this.position;
    this.bytes = new Uint8Array(
      await this.input
        .slice(this.start, Math.min(this.start + 64 * 1024, this.input.size))
        .arrayBuffer(),
    );
  }

  async read(length: number): Promise<Uint8Array> {
    if (this.position + length > this.input.size) invalid();
    if (this.position < this.start || this.position + length > this.start + this.bytes.length)
      await this.fill();
    const bytes = this.bytes.subarray(
      this.position - this.start,
      this.position - this.start + length,
    );
    if (bytes.length !== length) invalid();
    this.position += length;
    return bytes;
  }

  async subBlocks(collect = false): Promise<Uint8Array | undefined> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (this.position >= this.input.size) invalid();
      if (this.position >= this.start + this.bytes.length) await this.fill();
      const length = this.bytes[this.position++ - this.start];
      if (!length) break;
      total += length;
      if (collect) {
        if (total > MAX_MEDIA_SOURCE_BYTES)
          throw new GifSourceError('invalid-source', t('core.mp4.sourceTooLarge'));
        parts.push(await this.read(length));
      } else this.skip(length);
    }
    if (!collect) return undefined;
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function colorCount(packed: number): number {
  return packed & 0x80 ? 2 ** ((packed & 7) + 1) : 0;
}

async function parse(input: Blob): Promise<{ trailer: number; source?: MediaSourceMetadata }> {
  if (!Number.isSafeInteger(input.size) || input.size < 14) invalid();
  // Keep the existing source-file processing boundary for both supported formats.
  if (input.size > MAX_MP4_SOURCE_FILE_BYTES)
    throw new GifSourceError('unsupported-gif', t('core.gif.sizeLimit'));
  const reader = new Reader(input);
  const header = await reader.read(13);
  const signature = String.fromCharCode(...header.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') invalid();
  const width = u16(header, 6);
  const height = u16(header, 8);
  const globalColors = colorCount(header[10]);
  if (!width || !height || (globalColors && header[11] >= globalColors)) invalid();
  reader.skip(globalColors * 3);
  let source: MediaSourceMetadata | undefined;
  let graphics = 0;
  let control: { transparent?: number } | undefined;
  for (;;) {
    const marker = (await reader.read(1))[0];
    if (marker === 0x3b) {
      if (reader.position !== input.size || !graphics || control) invalid();
      return { trailer: reader.position - 1, source };
    }
    if (marker === 0x2c) {
      const image = await reader.read(9);
      const imageWidth = u16(image, 4);
      const imageHeight = u16(image, 6);
      const colors = colorCount(image[8]) || globalColors;
      if (
        !imageWidth ||
        !imageHeight ||
        !colors ||
        image[8] & 0x18 ||
        u16(image, 0) + imageWidth > width ||
        u16(image, 2) + imageHeight > height ||
        (control?.transparent !== undefined && control.transparent >= colors)
      )
        invalid();
      reader.skip(colorCount(image[8]) * 3);
      const codeSize = (await reader.read(1))[0];
      if (codeSize < 2 || codeSize > 8) invalid();
      const dataStart = reader.position;
      await reader.subBlocks();
      if (reader.position === dataStart + 1) invalid();
      graphics++;
      control = undefined;
      continue;
    }
    if (marker !== 0x21 || signature !== 'GIF89a') invalid();
    const label = (await reader.read(1))[0];
    if (label === 0xf9) {
      const block = await reader.read(6);
      if (
        control ||
        block[0] !== 4 ||
        block[5] !== 0 ||
        block[1] & 0xe0 ||
        ((block[1] >> 2) & 7) > 3
      )
        invalid();
      control = block[1] & 1 ? { transparent: block[4] } : {};
    } else if (label === 0xff) {
      if ((await reader.read(1))[0] !== 11) invalid();
      const application = String.fromCharCode(...(await reader.read(11)));
      const isSource = application === GIF_SOURCE_APPLICATION;
      if (isSource && source)
        throw new GifSourceError('source-conflict', t('core.mp4.duplicateSource'));
      const data = await reader.subBlocks(isSource);
      if (isSource) {
        try {
          source = parseMediaSourceMetadata(JSON.parse(decoder.decode(data)));
        } catch (error) {
          throw new GifSourceError(
            'invalid-source',
            t('core.mp4.invalidSource', {
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    } else if (label === 0xfe) {
      await reader.subBlocks();
    } else if (label === 0x01) {
      const block = await reader.read(13);
      if (
        block[0] !== 12 ||
        !globalColors ||
        !u16(block, 5) ||
        !u16(block, 7) ||
        u16(block, 1) + u16(block, 5) > width ||
        u16(block, 3) + u16(block, 7) > height ||
        !block[9] ||
        !block[10] ||
        block[11] >= globalColors ||
        block[12] >= globalColors ||
        (control?.transparent !== undefined && control.transparent >= globalColors)
      )
        invalid();
      await reader.subBlocks();
      graphics++;
      control = undefined;
    } else {
      throw new GifSourceError('unsupported-gif', t('core.gif.unsupportedExtension'));
    }
  }
}

export async function readGifSource(input: Blob): Promise<MediaSourceMetadata | undefined> {
  return (await parse(input)).source;
}

/** Preserve image, timing, loop, and existing extension blocks byte-for-byte. */
export async function embedGifSource(input: Blob, value: MediaSourceMetadata): Promise<Blob> {
  let source: MediaSourceMetadata;
  try {
    source = parseMediaSourceMetadata(value);
  } catch (error) {
    throw new GifSourceError(
      'invalid-source',
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = await parse(input);
  if (parsed.source) {
    if (JSON.stringify(parsed.source) === JSON.stringify(source))
      return input.type === 'image/gif' ? input : new Blob([input], { type: 'image/gif' });
    throw new GifSourceError('source-conflict', t('core.mp4.sourceConflict'));
  }
  const data = encoder.encode(JSON.stringify(source));
  const extension = new Uint8Array(14 + data.length + Math.ceil(data.length / 255) + 1);
  extension.set([0x21, 0xff, 11]);
  extension.set(encoder.encode(GIF_SOURCE_APPLICATION), 3);
  let offset = 14;
  for (let position = 0; position < data.length; position += 255) {
    const part = data.subarray(position, position + 255);
    extension[offset++] = part.length;
    extension.set(part, offset);
    offset += part.length;
  }
  const output = new Blob(
    ['GIF89a', input.slice(6, parsed.trailer), extension, input.slice(parsed.trailer)],
    { type: 'image/gif' },
  );
  if (output.size > MAX_MP4_SOURCE_FILE_BYTES)
    throw new GifSourceError('unsupported-gif', t('core.mp4.outputSizeLimit'));
  if (JSON.stringify(await readGifSource(output)) !== JSON.stringify(source))
    throw new GifSourceError('invalid-gif', t('core.gif.verificationFailed'));
  return output;
}
