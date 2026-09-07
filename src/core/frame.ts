import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { normalizeHandle } from '../shared/model.js';
import { renderTemplate } from './template.js';

export const DEFAULT_FRAME_TEMPLATE = '{author.name}';
export type FrameOrientation = 'top' | 'bottom' | 'left' | 'right';
export const DEFAULT_FRAME_ORIENTATION: FrameOrientation = 'bottom';
export const FRAME_ORIENTATIONS: FrameOrientation[] = ['top', 'bottom', 'left', 'right'];

export interface FrameTextMeasurement {
  measureText(text: string): { width: number };
}

export interface FrameLayoutInput extends FrameTextMeasurement {
  width: number;
  height?: number;
  userText: string;
  sourceLines: string[];
  fontSize?: number;
  orientation?: FrameOrientation;
}

export interface FrameLayout {
  orientation: FrameOrientation;
  mode: 'single' | 'double';
  width: number;
  fontSize: number;
  lineHeight: number;
  paddingX: number;
  paddingY: number;
  gap: number;
  leftWidth: number;
  rightWidth: number;
  leftLines: string[];
  rightLines: string[];
  barHeight: number;
  frameWidth: number;
  frameHeight: number;
  userColumns: string[];
  sourceColumns: string[];
  columnWidth: number;
}

export function wrapFrameText(
  text: string,
  maxWidth: number,
  measureText: FrameTextMeasurement['measureText']
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const character of [...paragraph]) {
      const candidate = current + character;
      if (current && measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

export function wrapVerticalText(text: string, maxHeight: number, lineHeight: number): string[] {
  const maxCharacters = Math.max(1, Math.floor(maxHeight / lineHeight));
  const columns: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.length === 0) {
      columns.push('');
      continue;
    }
    const characters = [...paragraph];
    for (let index = 0; index < characters.length; index += maxCharacters) {
      columns.push(characters.slice(index, index + maxCharacters).join(''));
    }
  }
  return columns;
}

function getMaxTextWidth(lines: string[], measureText: FrameTextMeasurement['measureText']): number {
  return Math.max(0, ...lines.map((line) => measureText(line).width));
}

export function calculateFrameLayout(input: FrameLayoutInput): FrameLayout {
  const orientation = input.orientation ?? DEFAULT_FRAME_ORIENTATION;
  const fontSize = input.fontSize ?? Math.max(12, Math.min(32, Math.round(input.width * 0.035)));
  const lineHeight = Math.round(fontSize * 1.4);
  const paddingX = Math.max(16, Math.round(input.width * 0.04));
  const paddingY = Math.max(12, Math.round(fontSize * 0.55));
  const gap = Math.max(16, Math.round(input.width * 0.03));

  if (orientation === 'left' || orientation === 'right') {
    const height = input.height ?? input.width;
    const verticalTextHeight = Math.max(1, height - paddingY * 2);
    const userColumns = wrapVerticalText(input.userText, verticalTextHeight, lineHeight);
    const sourceColumns = input.sourceLines.flatMap((line) => wrapVerticalText(line, verticalTextHeight, lineHeight));
    const columnWidth = Math.max(fontSize * 1.4, lineHeight);
    const columnGap = sourceColumns.length > 0 ? gap : 0;
    const frameWidth = paddingX * 2 + (userColumns.length + sourceColumns.length) * columnWidth + columnGap;
    return {
      orientation,
      mode: 'single',
      width: input.width,
      fontSize,
      lineHeight,
      paddingX,
      paddingY,
      gap,
      leftWidth: 0,
      rightWidth: 0,
      leftLines: [],
      rightLines: [],
      barHeight: 0,
      frameWidth,
      frameHeight: height,
      userColumns,
      sourceColumns,
      columnWidth
    };
  }

  const availableWidth = Math.max(1, input.width - paddingX * 2);
  const sourceWidth = getMaxTextWidth(input.sourceLines, input.measureText);
  const minLeftWidth = Math.max(fontSize * 6, input.measureText('模板').width);
  const canUseDoubleColumn = availableWidth - gap >= minLeftWidth + sourceWidth;

  if (canUseDoubleColumn) {
    const leftWidth = availableWidth - gap - sourceWidth;
    const leftLines = wrapFrameText(input.userText, leftWidth, input.measureText);
    const rightLines = input.sourceLines;
    return {
      orientation,
      mode: 'double',
      width: input.width,
      fontSize,
      lineHeight,
      paddingX,
      paddingY,
      gap,
      leftWidth,
      rightWidth: sourceWidth,
      leftLines,
      rightLines,
      barHeight: paddingY * 2 + lineHeight * Math.max(leftLines.length, rightLines.length),
      frameWidth: input.width,
      frameHeight: paddingY * 2 + lineHeight * Math.max(leftLines.length, rightLines.length),
      userColumns: [],
      sourceColumns: [],
      columnWidth: 0
    };
  }

  const leftLines = [
    ...wrapFrameText(input.userText, availableWidth, input.measureText),
    ...input.sourceLines.flatMap((line) => wrapFrameText(line, availableWidth, input.measureText))
  ];
  return {
    orientation,
    mode: 'single',
    width: input.width,
    fontSize,
    lineHeight,
    paddingX,
    paddingY,
    gap,
    leftWidth: availableWidth,
    rightWidth: 0,
    leftLines,
    rightLines: [],
    barHeight: paddingY * 2 + lineHeight * leftLines.length,
    frameWidth: input.width,
    frameHeight: paddingY * 2 + lineHeight * leftLines.length,
    userColumns: [],
    sourceColumns: [],
    columnWidth: 0
  };
}

function getFrameText(record: TweetRecord, media: MediaRecord, template: string): string {
  return renderTemplate(template, { tweet: record, media, extension: 'png' }).trim();
}

function getSourceLines(record: TweetRecord): string[] {
  return [`tweet id: ${record.tweetId}`, normalizeHandle(record.author.handle)];
}

async function fetchPhotoBlob(media: MediaRecord): Promise<Blob> {
  if (!media.originalUrl) throw new Error('当前照片没有可用的原图地址');
  const response = await fetch(media.originalUrl, { credentials: 'omit' });
  if (!response.ok) throw new Error(`原图请求失败：HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('原图响应为空');
  return blob;
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.src = objectUrl;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('原图无法解码'));
    });
    return image;
  } catch (error) {
    image.remove();
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG 画框生成失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

export async function renderPhotoFrame(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FRAME_TEMPLATE,
  orientation: FrameOrientation = DEFAULT_FRAME_ORIENTATION
): Promise<Blob> {
  if (media.type !== 'photo') throw new Error('只有照片支持生成画框');
  const blob = await fetchPhotoBlob(media);
  const image = await loadImage(blob);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 Canvas 画框渲染');

  const userText = getFrameText(record, media, template);
  const sourceLines = getSourceLines(record);
  const fontSize = Math.max(12, Math.min(32, Math.round(image.naturalWidth * 0.035)));
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  const layout = calculateFrameLayout({
    width: image.naturalWidth,
    height: image.naturalHeight,
    userText,
    sourceLines,
    fontSize,
    orientation,
    measureText: (text) => context.measureText(text)
  });

  const horizontal = orientation === 'top' || orientation === 'bottom';
  canvas.width = horizontal ? image.naturalWidth : image.naturalWidth + layout.frameWidth;
  canvas.height = horizontal ? image.naturalHeight + layout.barHeight : image.naturalHeight;
  const imageX = orientation === 'left' ? layout.frameWidth : 0;
  const imageY = orientation === 'top' ? layout.barHeight : 0;
  context.drawImage(image, imageX, imageY, image.naturalWidth, image.naturalHeight);
  context.fillStyle = '#ffffff';
  if (horizontal) {
    context.fillRect(0, orientation === 'top' ? 0 : image.naturalHeight, canvas.width, layout.barHeight);
  } else {
    context.fillRect(orientation === 'left' ? 0 : image.naturalWidth, 0, layout.frameWidth, canvas.height);
  }
  context.fillStyle = '#16181c';
  context.font = `600 ${layout.fontSize}px system-ui, sans-serif`;
  context.textBaseline = 'top';

  if (!horizontal) {
    const frameX = orientation === 'left' ? 0 : image.naturalWidth;
    const columns = [...layout.userColumns, ...layout.sourceColumns];
    context.textAlign = 'center';
    columns.forEach((column, columnIndex) => {
      const x = frameX + layout.paddingX + columnIndex * layout.columnWidth + layout.columnWidth / 2;
      [...column].forEach((character, characterIndex) => {
        context.fillText(character, x, layout.paddingY + characterIndex * layout.lineHeight);
      });
    });
  } else if (layout.mode === 'double') {
    const frameY = orientation === 'top' ? 0 : image.naturalHeight;
    context.textAlign = 'left';
    layout.leftLines.forEach((line, index) => {
      context.fillText(line, layout.paddingX, frameY + layout.paddingY + index * layout.lineHeight);
    });
    context.textAlign = 'right';
    layout.rightLines.forEach((line, index) => {
      context.fillText(line, canvas.width - layout.paddingX, frameY + layout.paddingY + index * layout.lineHeight);
    });
  } else {
    const frameY = orientation === 'top' ? 0 : image.naturalHeight;
    context.textAlign = 'left';
    layout.leftLines.forEach((line, index) => {
      context.fillText(line, layout.paddingX, frameY + layout.paddingY + index * layout.lineHeight);
    });
  }

  const result = await canvasToBlob(canvas);
  image.remove();
  URL.revokeObjectURL(image.src);
  return result;
}
