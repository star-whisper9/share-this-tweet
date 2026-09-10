import {
  MAX_MEDIA_SOURCE_BYTES,
  parseMediaSourceMetadata,
  type MediaSourceMetadata,
} from '../shared/media-source.js';

// A deliberately limited, self-contained MP4 profile. No media bytes are decoded.
export const MAX_MP4_SOURCE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;
const MAX_BOXES = 4096;
const SOURCE_UUID = new Uint8Array([
  0xdc, 0x1b, 0xf7, 0x8d, 0xa5, 0xe7, 0x4f, 0x3d, 0x9c, 0x67, 0x7e, 0xe6, 0xf0, 0x12, 0xca, 0x03,
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class Mp4SourceError extends Error {
  constructor(
    public readonly code: 'invalid-mp4' | 'unsupported-mp4' | 'invalid-source' | 'source-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'Mp4SourceError';
  }
}

interface Box {
  type: string;
  start: number;
  end: number;
  size: number;
  header: number;
  toEnd: boolean;
}
interface ParsedMp4 {
  top: Box[];
  moov: Box;
  bytes: Uint8Array;
  children: Box[];
  udta?: Box;
  userData: Box[];
  source?: MediaSourceMetadata;
}

function invalid(message = 'MP4 文件结构损坏或不完整'): never {
  throw new Mp4SourceError('invalid-mp4', message);
}
function unsupported(message: string): never {
  throw new Mp4SourceError('unsupported-mp4', message);
}
function u32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) invalid();
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}
function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) invalid();
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}
function uint64(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > bytes.length) invalid();
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported('MP4 偏移超出安全处理范围');
  return Number(value);
}
function typeAt(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) invalid();
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}
function header(bytes: Uint8Array, start: number, end: number, offset = start): Box {
  if (end - start < 8) invalid();
  const length = u32(bytes, offset);
  const size = length === 1 ? uint64(bytes, offset + 8) : length === 0 ? end - start : length;
  const header = length === 1 ? 16 : 8;
  if (!Number.isSafeInteger(size) || size < header || size > end - start) invalid();
  return {
    type: typeAt(bytes, offset + 4),
    start,
    end: start + size,
    size,
    header,
    toEnd: length === 0,
  };
}

function children(bytes: Uint8Array, parent: Box, skip = 0): Box[] {
  const result: Box[] = [];
  let position = parent.start + parent.header + skip;
  if (position > parent.end) invalid();
  while (position < parent.end) {
    if (result.length >= MAX_BOXES) unsupported('MP4 容器项目过多');
    const child = header(bytes, position, parent.end);
    // Nested EOF lengths would consume newly appended metadata; don't guess at them.
    if (child.toEnd) unsupported('暂不支持内部长度未明确的 MP4 容器');
    result.push(child);
    position = child.end;
  }
  return result;
}

function only(boxes: Box[], type: string, required = true): Box | undefined {
  const matches = boxes.filter((box) => box.type === type);
  if (matches.length > 1 || (required && matches.length !== 1)) invalid();
  return matches[0];
}
function allow(boxes: Box[], allowed: string[]): void {
  const unknown = boxes.find((box) => !allowed.includes(box.type));
  if (unknown) unsupported(`暂不支持此 MP4 结构（${unknown.type}），可选择原样保存`);
}
function payload(bytes: Uint8Array, box: Box, minimum: number): number {
  const offset = box.start + box.header;
  if (box.end > bytes.length || box.end - offset < minimum) invalid();
  return offset;
}
function fullBox(bytes: Uint8Array, box: Box, minimum = 4): number {
  const offset = payload(bytes, box, minimum);
  if (u32(bytes, offset) !== 0) unsupported(`暂不支持此 MP4 ${box.type} 版本`);
  return offset;
}

function validateSampleDescription(bytes: Uint8Array, box: Box, kind: string): void {
  const offset = fullBox(bytes, box, 8);
  const entries = children(bytes, box, 8);
  if (entries.length !== u32(bytes, offset + 4) || !entries.length || entries.length > 32)
    invalid();
  for (const entry of entries) {
    const start = payload(bytes, entry, 8);
    if (u16(bytes, start + 6) !== 1) unsupported('暂不支持外部媒体引用');
    if (kind === 'vide' && (entry.type === 'avc1' || entry.type === 'avc3')) {
      payload(bytes, entry, 78);
      const extensions = children(bytes, entry, 78);
      allow(extensions, ['avcC', 'btrt', 'pasp', 'colr', 'clap', 'fiel']);
      only(extensions, 'avcC');
    } else if (kind === 'soun' && entry.type === 'mp4a') {
      payload(bytes, entry, 28);
      if (u16(bytes, start + 8) !== 0) unsupported('暂不支持此音频采样描述版本');
      const extensions = children(bytes, entry, 28);
      allow(extensions, ['esds', 'btrt']);
      only(extensions, 'esds');
    } else unsupported(`暂不支持此 MP4 编码（${entry.type}），可选择原样保存`);
  }
}

function validateTrack(bytes: Uint8Array, track: Box, mediaData: Box[]): void {
  const trackChildren = children(bytes, track);
  allow(trackChildren, ['tkhd', 'mdia', 'edts', 'udta']);
  only(trackChildren, 'tkhd');
  const edits = only(trackChildren, 'edts', false);
  if (edits) {
    const entries = children(bytes, edits);
    allow(entries, ['elst']);
    only(entries, 'elst');
  }
  const mdia = children(bytes, only(trackChildren, 'mdia')!);
  allow(mdia, ['mdhd', 'hdlr', 'minf']);
  only(mdia, 'mdhd');
  const handler = only(mdia, 'hdlr')!;
  const kind = typeAt(bytes, payload(bytes, handler, 12) + 8);
  if (kind !== 'vide' && kind !== 'soun') unsupported('暂不支持含其他轨道类型的 MP4');
  const minf = children(bytes, only(mdia, 'minf')!);
  allow(minf, ['vmhd', 'smhd', 'dinf', 'stbl']);
  only(minf, kind === 'vide' ? 'vmhd' : 'smhd');
  const dinf = children(bytes, only(minf, 'dinf')!);
  allow(dinf, ['dref']);
  const dref = only(dinf, 'dref')!;
  const drefStart = fullBox(bytes, dref, 8);
  const references = children(bytes, dref, 8);
  if (u32(bytes, drefStart + 4) !== 1 || references.length !== 1) unsupported('暂不支持多媒体引用');
  const reference = references[0];
  if (
    reference.type !== 'url ' ||
    reference.size !== reference.header + 4 ||
    u32(bytes, reference.start + reference.header) !== 1
  )
    unsupported('暂不支持外部媒体引用');

  const table = children(bytes, only(minf, 'stbl')!);
  allow(table, [
    'stsd',
    'stts',
    'ctts',
    'cslg',
    'stss',
    'stsc',
    'stsz',
    'stco',
    'co64',
    'sdtp',
    'sgpd',
    'sbgp',
  ]);
  for (const group of table.filter((item) => item.type === 'sgpd' || item.type === 'sbgp')) {
    const offset = payload(bytes, group, 8);
    const kind = typeAt(bytes, offset + 4);
    // Roll-recovery groups contain sample counts, not file positions or encryption data.
    if (kind !== 'roll' && kind !== 'prol') unsupported('暂不支持此 MP4 采样分组');
  }
  for (const type of ['stsd', 'stts', 'stsc', 'stsz']) only(table, type);
  validateSampleDescription(bytes, only(table, 'stsd')!, kind);
  const offsets = table.filter((box) => box.type === 'stco' || box.type === 'co64');
  if (offsets.length !== 1) invalid();
  const box = offsets[0];
  const start = fullBox(bytes, box, 8);
  const count = u32(bytes, start + 4);
  const width = box.type === 'co64' ? 8 : 4;
  if (!count || box.end - start !== 8 + count * width) invalid();
  for (let index = 0; index < count; index++) {
    const offset =
      width === 8
        ? uint64(bytes, start + 8 + index * width)
        : u32(bytes, start + 8 + index * width);
    if (!mediaData.some((mdat) => offset >= mdat.start + mdat.header && offset < mdat.end))
      unsupported('媒体采样偏移未指向文件内的媒体数据');
  }
}

function sourceFromUserData(bytes: Uint8Array, boxes: Box[]): MediaSourceMetadata | undefined {
  let source: MediaSourceMetadata | undefined;
  for (const box of boxes) {
    if (box.type !== 'uuid') continue;
    const offset = payload(bytes, box, 16);
    if (!SOURCE_UUID.every((byte, index) => bytes[offset + index] === byte)) continue;
    if (source) throw new Mp4SourceError('source-conflict', '文件包含重复的来源信息');
    if (box.end - offset - 16 > MAX_MEDIA_SOURCE_BYTES)
      throw new Mp4SourceError('invalid-source', '文件来源信息过大');
    try {
      source = parseMediaSourceMetadata(
        JSON.parse(decoder.decode(bytes.subarray(offset + 16, box.end))),
      );
    } catch (error) {
      throw new Mp4SourceError(
        'invalid-source',
        `文件来源信息无效：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return source;
}

async function parse(input: Blob): Promise<ParsedMp4> {
  if (!Number.isSafeInteger(input.size) || input.size < 8) invalid();
  if (input.size > MAX_MP4_SOURCE_FILE_BYTES) unsupported('来源处理暂支持不超过 2 GiB 的 MP4');
  const top: Box[] = [];
  let position = 0;
  while (position < input.size) {
    if (top.length >= MAX_BOXES) unsupported('MP4 容器项目过多');
    const bytes = new Uint8Array(
      await input.slice(position, Math.min(position + 16, input.size)).arrayBuffer(),
    );
    const box = header(bytes, position, input.size, 0);
    top.push(box);
    position = box.end;
  }
  allow(top, ['ftyp', 'moov', 'mdat', 'free', 'skip']);
  const ftyp = only(top, 'ftyp')!;
  if (ftyp.start !== 0 || ftyp.size > 1024 || ftyp.size < ftyp.header + 8) invalid();
  const brands = new Uint8Array(
    await input.slice(ftyp.start + ftyp.header, ftyp.end).arrayBuffer(),
  );
  if ((brands.length - 8) % 4) invalid();
  const supportedBrands = ['isom', 'iso2', 'mp41', 'mp42', 'avc1'];
  if (!supportedBrands.includes(typeAt(brands, 0))) unsupported('暂不支持此媒体容器品牌');
  const moov = only(top, 'moov')!;
  const mediaData = top.filter((box) => box.type === 'mdat');
  if (!mediaData.length || mediaData.some((box) => box.size === box.header)) invalid();
  if (moov.size > MAX_MOOV_BYTES) unsupported('MP4 索引过大，无法安全处理');
  const bytes = new Uint8Array(await input.slice(moov.start, moov.end).arrayBuffer());
  const root = header(bytes, 0, bytes.length);
  const movieChildren = children(bytes, root);
  allow(movieChildren, ['mvhd', 'iods', 'trak', 'udta']);
  only(movieChildren, 'mvhd');
  const tracks = movieChildren.filter((box) => box.type === 'trak');
  if (!tracks.length || tracks.length > 16) unsupported('MP4 轨道数量不受支持');
  for (const track of tracks) validateTrack(bytes, track, mediaData);
  const udta = only(movieChildren, 'udta', false);
  const userData = udta ? children(bytes, udta) : [];
  for (const item of userData) {
    if (['iloc', 'moof', 'sidx', 'saio', 'mvex'].includes(item.type))
      unsupported('暂不支持含位置引用的媒体元数据');
    if (item.type === 'meta') {
      fullBox(bytes, item);
      const entries = children(bytes, item, 4);
      allow(entries, ['hdlr', 'ilst', 'keys', 'free']);
      only(entries, 'hdlr', false);
      const list = only(entries, 'ilst', false);
      if (list) children(bytes, list);
    }
  }
  // udta is user metadata, not a sample-location tree. Preserve unrecognized values verbatim.
  const source = sourceFromUserData(bytes, userData);
  return { top, moov, bytes, children: movieChildren, udta, userData, source };
}

function box(type: string, parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + parts.reduce((total, part) => total + part.length, 0);
  if (size > MAX_MOOV_BYTES) unsupported('MP4 索引过大，无法安全处理');
  const result = new Uint8Array(size);
  new DataView(result.buffer).setUint32(0, size);
  for (let index = 0; index < 4; index++) result[4 + index] = type.charCodeAt(index);
  let offset = 8;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function original(bytes: Uint8Array, item: Box): Uint8Array {
  return bytes.subarray(item.start, item.end);
}
function commentBox(source: MediaSourceMetadata): Uint8Array {
  // iTunes-style UTF-8 data atom: type indicator 1, locale 0.
  return box('©cmt', [
    box('data', [
      new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]),
      encoder.encode(
        `Source publisher: ${source.publisher.name} (${source.publisher.handle})\n${source.tweetUrl}`,
      ),
    ]),
  ]);
}
function makeMeta(comment: Uint8Array): Uint8Array {
  const handler = new Uint8Array(25);
  handler.set(encoder.encode('mdir'), 8);
  return box('meta', [new Uint8Array(4), box('hdlr', [handler]), box('ilst', [comment])]);
}

function addUserData(parsed: ParsedMp4, source: MediaSourceMetadata): Uint8Array {
  const { bytes, userData } = parsed;
  const meta = only(userData, 'meta', false);
  const sourceBox = box('uuid', [SOURCE_UUID, encoder.encode(JSON.stringify(source))]);
  const comment = commentBox(source);
  let newMeta: Uint8Array | undefined;
  if (!meta && !userData.some((item) => item.type === '©cmt')) newMeta = makeMeta(comment);
  if (meta) {
    const start = fullBox(bytes, meta);
    const entries = children(bytes, meta, 4);
    const handler = only(entries, 'hdlr', false);
    const list = only(entries, 'ilst', false);
    // mdta/other metadata schemes remain byte-identical. Do not invent a competing comment.
    if (handler && typeAt(bytes, payload(bytes, handler, 12) + 8) === 'mdir' && list) {
      const fields = children(bytes, list);
      if (
        !fields.some((item) => item.type === '©cmt') &&
        !userData.some((item) => item.type === '©cmt')
      ) {
        const newList = box('ilst', [...fields.map((item) => original(bytes, item)), comment]);
        newMeta = box('meta', [
          bytes.subarray(start, start + 4),
          ...entries.map((item) => (item === list ? newList : original(bytes, item))),
        ]);
      }
    }
  }
  return box('udta', [
    ...userData.map((item) => (item === meta && newMeta ? newMeta : original(bytes, item))),
    ...(!meta && newMeta ? [newMeta] : []),
    sourceBox,
  ]);
}

/** Read this extension's provenance. Valid supported MP4 without provenance returns undefined. */
export async function readMp4Source(input: Blob): Promise<MediaSourceMetadata | undefined> {
  return (await parse(input)).source;
}

/** Keep all media bytes at their existing file offsets; move only the movie index. */
export async function embedMp4Source(input: Blob, value: MediaSourceMetadata): Promise<Blob> {
  let source: MediaSourceMetadata;
  try {
    source = parseMediaSourceMetadata(value);
  } catch (error) {
    throw new Mp4SourceError(
      'invalid-source',
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = await parse(input);
  if (parsed.source) {
    if (JSON.stringify(parsed.source) === JSON.stringify(source))
      return input.type === 'video/mp4' ? input : new Blob([input], { type: 'video/mp4' });
    throw new Mp4SourceError('source-conflict', '文件已有不同来源信息，未覆盖原有记录');
  }
  const userData = addUserData(parsed, source);
  const movie = box('moov', [
    ...parsed.children.map((item) =>
      item === parsed.udta ? userData : original(parsed.bytes, item),
    ),
    ...(!parsed.udta ? [userData] : []),
  ]);
  const parts: BlobPart[] = [];
  for (const item of parsed.top) {
    if (item === parsed.moov) {
      if (item.end === input.size) {
        parts.push(movie);
        continue;
      }
      const replacement = new Uint8Array(parsed.bytes.subarray(0, item.header));
      replacement.set(encoder.encode('free'), 4);
      parts.push(replacement, input.slice(item.start + item.header, item.end));
    } else if (item.toEnd) {
      const replacement = new Uint8Array(8);
      new DataView(replacement.buffer).setUint32(0, item.size);
      replacement.set(encoder.encode(item.type), 4);
      parts.push(replacement, input.slice(item.start + item.header, item.end));
    } else parts.push(input.slice(item.start, item.end));
  }
  if (parsed.moov.end !== input.size) parts.push(movie);
  const output = new Blob(parts, { type: 'video/mp4' });
  if (output.size > MAX_MP4_SOURCE_FILE_BYTES) unsupported('写入来源后文件超过 2 GiB 处理上限');
  // Re-read the output's structure and provenance before handing it to downloads.
  const verified = await readMp4Source(output);
  if (JSON.stringify(verified) !== JSON.stringify(source)) invalid('写入来源后的文件验证失败');
  return output;
}
