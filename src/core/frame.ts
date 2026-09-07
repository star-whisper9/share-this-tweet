import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { normalizeHandle } from '../shared/model.js';
import { renderTemplate } from './template.js';

export const DEFAULT_FRAME_TEMPLATE = '{author.name}';

export interface FrameTextMeasurement {
  measureText(text: string): { width: number };
}

export interface FrameLayoutInput extends FrameTextMeasurement {
  width: number;
  userText: string;
  sourceLines: string[];
  fontSize?: number;
}

export interface FrameLayout {
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

function getMaxTextWidth(lines: string[], measureText: FrameTextMeasurement['measureText']): number {
  return Math.max(0, ...lines.map((line) => measureText(line).width));
}

export function calculateFrameLayout(input: FrameLayoutInput): FrameLayout {
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
      barHeight: paddingY * 2 + lineHeight * Math.max(leftLines.length, rightLines.length)
    };
  }

  const leftLines = [
    ...wrapFrameText(input.userText, availableWidth, input.measureText),
    ...input.sourceLines.flatMap((line) => wrapFrameText(line, availableWidth, input.measureText))
  ];
  return {
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
    barHeight: paddingY * 2 + lineHeight * leftLines.length
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
  template = DEFAULT_FRAME_TEMPLATE
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
    userText,
    sourceLines,
    fontSize,
    measureText: (text) => context.measureText(text)
  });

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight + layout.barHeight;
  context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  context.fillStyle = '#ffffff';
  context.fillRect(0, image.naturalHeight, canvas.width, layout.barHeight);
  context.fillStyle = '#16181c';
  context.font = `600 ${layout.fontSize}px system-ui, sans-serif`;
  context.textBaseline = 'top';

  if (layout.mode === 'double') {
    context.textAlign = 'left';
    layout.leftLines.forEach((line, index) => {
      context.fillText(line, layout.paddingX, image.naturalHeight + layout.paddingY + index * layout.lineHeight);
    });
    context.textAlign = 'right';
    layout.rightLines.forEach((line, index) => {
      context.fillText(line, canvas.width - layout.paddingX, image.naturalHeight + layout.paddingY + index * layout.lineHeight);
    });
  } else {
    context.textAlign = 'left';
    layout.leftLines.forEach((line, index) => {
      context.fillText(line, layout.paddingX, image.naturalHeight + layout.paddingY + index * layout.lineHeight);
    });
  }

  const result = await canvasToBlob(canvas);
  image.remove();
  URL.revokeObjectURL(image.src);
  return result;
}
