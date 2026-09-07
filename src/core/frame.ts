import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { normalizeHandle } from '../shared/model.js';
import { parseTemplate, renderTemplate } from './template.js';

export const DEFAULT_FRAME_TEMPLATE = '{author.name}';
export type FrameOrientation = 'top' | 'bottom';
export const DEFAULT_FRAME_ORIENTATION: FrameOrientation = 'bottom';
export const FRAME_ORIENTATIONS: FrameOrientation[] = ['top', 'bottom'];
const FRAME_AVATAR_MARKER = '\uE000';
const FRAME_FONT_FAMILY = '"SF Pro Display", "Helvetica Neue", system-ui, sans-serif';
const FRAME_BACKGROUND = '#fbfaf7';
const FRAME_BORDER = '#dfe3e8';

export interface FrameTextMeasurement {
  measureText(text: string): { width: number };
}

export interface FrameLayoutInput extends FrameTextMeasurement {
  width: number;
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
}

export function wrapFrameText(
  text: string,
  maxWidth: number,
  measureText: FrameTextMeasurement['measureText'],
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

function getMaxTextWidth(
  lines: string[],
  measureText: FrameTextMeasurement['measureText'],
): number {
  return Math.max(0, ...lines.map((line) => measureText(line).width));
}

export function calculateFrameLayout(input: FrameLayoutInput): FrameLayout {
  const orientation = input.orientation ?? DEFAULT_FRAME_ORIENTATION;
  const fontSize = input.fontSize ?? Math.max(12, Math.min(32, Math.round(input.width * 0.035)));
  const lineHeight = Math.round(fontSize * 1.4);
  const paddingX = Math.max(16, Math.round(input.width * 0.04));
  const paddingY = Math.max(12, Math.round(fontSize * 0.55));
  const gap = Math.max(16, Math.round(input.width * 0.03));

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
    };
  }

  const leftLines = [
    ...wrapFrameText(input.userText, availableWidth, input.measureText),
    ...input.sourceLines.flatMap((line) => wrapFrameText(line, availableWidth, input.measureText)),
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
  };
}

function getFrameText(record: TweetRecord, media: MediaRecord, template: string): string {
  const context = { tweet: record, media, extension: 'png' };
  return parseTemplate(template)
    .map((segment) => {
      if (segment.type === 'literal') return segment.value;
      if (segment.value === 'author.avatar') return FRAME_AVATAR_MARKER;
      return renderTemplate(`{${segment.value}}`, context);
    })
    .join('')
    .trim();
}

function getSourceLines(record: TweetRecord): string[] {
  return [`tweet id: ${record.tweetId}`, normalizeHandle(record.author.handle)];
}

function createFrameTextMeasurer(
  context: CanvasRenderingContext2D,
  fontSize: number,
): FrameTextMeasurement['measureText'] {
  const avatarWidth = fontSize * 1.25 + fontSize * 0.3;
  return (text) => ({
    width: text
      .split(FRAME_AVATAR_MARKER)
      .reduce(
        (width, part, index, parts) =>
          width + context.measureText(part).width + (index < parts.length - 1 ? avatarWidth : 0),
        0,
      ),
  });
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

async function loadAvatarImage(
  record: TweetRecord,
  frameText: string,
): Promise<HTMLImageElement | undefined> {
  if (!frameText.includes(FRAME_AVATAR_MARKER)) return undefined;
  const urls = [
    record.author.avatarUrl,
    browser.runtime.getURL('/icons/x.png'),
    browser.runtime.getURL('/icons/x.svg'),
  ].filter((url): url is string => Boolean(url));
  for (const url of urls) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) continue;
      return await loadImage(await response.blob());
    } catch {
      // Try the next source, then use the generated X fallback.
    }
  }
  return undefined;
}

function drawAvatarFallback(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  context.save();
  context.fillStyle = '#111111';
  context.fillRect(x, y, size, size);
  context.fillStyle = '#ffffff';
  context.font = `600 ${Math.max(10, size * 0.62)}px ${FRAME_FONT_FAMILY}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('X', x + size / 2, y + size / 2);
  context.restore();
}

function drawHorizontalTextLine(
  context: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  fontSize: number,
  avatarImage?: HTMLImageElement,
): void {
  if (!line.includes(FRAME_AVATAR_MARKER)) {
    context.fillText(line, x, y);
    return;
  }
  let cursor = x;
  for (const character of [...line]) {
    if (character !== FRAME_AVATAR_MARKER) {
      context.fillText(character, cursor, y);
      cursor += context.measureText(character).width;
      continue;
    }
    const size = fontSize * 1.25;
    const top = y - size / 2;
    if (avatarImage) context.drawImage(avatarImage, cursor, top, size, size);
    else drawAvatarFallback(context, cursor, top, size);
    cursor += size + fontSize * 0.3;
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
  orientation: FrameOrientation = DEFAULT_FRAME_ORIENTATION,
): Promise<Blob> {
  if (media.type !== 'photo') throw new Error('只有照片支持生成画框');
  const userText = getFrameText(record, media, template);
  const blob = await fetchPhotoBlob(media);
  const image = await loadImage(blob);
  const avatarImage = await loadAvatarImage(record, userText);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 Canvas 画框渲染');

  const sourceLines = getSourceLines(record);
  const fontSize = Math.max(12, Math.min(32, Math.round(image.naturalWidth * 0.035)));
  context.font = `500 ${fontSize}px ${FRAME_FONT_FAMILY}`;
  const layout = calculateFrameLayout({
    width: image.naturalWidth,
    userText,
    sourceLines,
    fontSize,
    orientation,
    measureText: createFrameTextMeasurer(context, fontSize),
  });

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight + layout.barHeight;
  const imageY = orientation === 'top' ? layout.barHeight : 0;
  context.drawImage(image, 0, imageY, image.naturalWidth, image.naturalHeight);
  context.fillStyle = FRAME_BACKGROUND;
  context.fillRect(
    0,
    orientation === 'top' ? 0 : image.naturalHeight,
    canvas.width,
    layout.barHeight,
  );
  context.fillStyle = '#1f2933';
  context.font = `500 ${layout.fontSize}px ${FRAME_FONT_FAMILY}`;
  // Each line occupies a fixed-height cell. Centering the glyph in that cell
  // keeps the same paddingY on both sides of a top or bottom frame, regardless
  // of the font's ascent/descent metrics.
  context.textBaseline = 'middle';

  if (layout.mode === 'double') {
    const frameY = orientation === 'top' ? 0 : image.naturalHeight;
    context.textAlign = 'left';
    layout.leftLines.forEach((line, index) => {
      drawHorizontalTextLine(
        context,
        line,
        layout.paddingX,
        frameY + layout.paddingY + (index + 0.5) * layout.lineHeight,
        layout.fontSize,
        avatarImage,
      );
    });
    context.textAlign = 'right';
    layout.rightLines.forEach((line, index) => {
      context.globalAlpha = index === 0 ? 0.62 : 0.9;
      context.font = `${index === 0 ? 450 : 550} ${layout.fontSize}px ${FRAME_FONT_FAMILY}`;
      context.fillText(
        line,
        canvas.width - layout.paddingX,
        frameY + layout.paddingY + (index + 0.5) * layout.lineHeight,
      );
    });
    context.globalAlpha = 1;
  } else {
    const frameY = orientation === 'top' ? 0 : image.naturalHeight;
    context.textAlign = 'left';
    layout.leftLines.forEach((line, index) => {
      drawHorizontalTextLine(
        context,
        line,
        layout.paddingX,
        frameY + layout.paddingY + (index + 0.5) * layout.lineHeight,
        layout.fontSize,
        avatarImage,
      );
    });
  }

  context.globalAlpha = 1;
  context.strokeStyle = FRAME_BORDER;
  context.lineWidth = 1;
  const frameY = orientation === 'top' ? 0 : image.naturalHeight;
  context.strokeRect(0.5, frameY + 0.5, canvas.width - 1, layout.barHeight - 1);

  const result = await canvasToBlob(canvas);
  image.remove();
  URL.revokeObjectURL(image.src);
  avatarImage?.remove();
  if (avatarImage) URL.revokeObjectURL(avatarImage.src);
  return result;
}
