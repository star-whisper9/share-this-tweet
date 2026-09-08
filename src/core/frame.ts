import { IMAGE_PALETTES, detectImageTheme, type ImageTheme } from './image-theme.js';
import { ImageResources, loadAvatar, releaseImage } from './image-resources.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { renderTemplate } from './template.js';

export const DEFAULT_FRAME_TEMPLATE = '{author.name}';
export type FrameOrientation = 'top' | 'bottom';
export const DEFAULT_FRAME_ORIENTATION: FrameOrientation = 'bottom';
export const FRAME_ORIENTATIONS: FrameOrientation[] = ['top', 'bottom'];
const FRAME_AVATAR_MARKER = '\uE000';
const FRAME_BRAND_MARKER = '\uE001';
const FRAME_FONT_FAMILY = '"SF Pro Display", "Helvetica Neue", system-ui, sans-serif';

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

function getFrameText(
  record: TweetRecord,
  media: MediaRecord,
  template: string,
  extension = 'jpg',
): string {
  const context = { tweet: record, media, extension };
  return renderTemplate(template, { ...context, avatarMarker: FRAME_AVATAR_MARKER }).trim();
}

function getSourceLines(record: TweetRecord): string[] {
  return [record.tweetId, `${FRAME_BRAND_MARKER}分享有据`];
}

function createFrameTextMeasurer(
  context: CanvasRenderingContext2D,
  fontSize: number,
): FrameTextMeasurement['measureText'] {
  const avatarWidth = fontSize * 1.25 + fontSize * 0.3;
  return (text) => ({
    width: text
      .split(/[\uE000\uE001]/)
      .reduce(
        (width, part, index, parts) =>
          width + context.measureText(part).width + (index < parts.length - 1 ? avatarWidth : 0),
        0,
      ),
  });
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
  brandImage?: HTMLImageElement,
): void {
  if (!/[\uE000\uE001]/.test(line)) {
    context.fillText(line, x, y);
    return;
  }
  context.save();
  let cursor =
    context.textAlign === 'right' ? x - createFrameTextMeasurer(context, fontSize)(line).width : x;
  context.textAlign = 'left';
  for (const character of [...line]) {
    if (character !== FRAME_AVATAR_MARKER && character !== FRAME_BRAND_MARKER) {
      context.fillText(character, cursor, y);
      cursor += context.measureText(character).width;
      continue;
    }
    const size = fontSize * 1.25;
    const top = y - size / 2;
    const picture = character === FRAME_BRAND_MARKER ? brandImage : avatarImage;
    if (picture) context.drawImage(picture, cursor, top, size, size);
    else drawAvatarFallback(context, cursor, top, size);
    cursor += size + fontSize * 0.3;
  }
  context.restore();
}

/** Read bounded strips rather than allocating a second full-size RGBA image. */
export function hasTransparentPixels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  offsetY = 0,
): boolean {
  for (let y = 0; y < height; y += 64) {
    const pixels = context.getImageData(0, y + offsetY, width, Math.min(64, height - y)).data;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 255) return true;
    }
  }
  return false;
}

export function encodeFrame(canvas: HTMLCanvasElement, transparent: boolean): Promise<Blob> {
  const type = transparent ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== type) {
          reject(new Error(`浏览器无法生成 ${type} 画框`));
          return;
        }
        resolve(blob);
      },
      type,
      0.92,
    );
  });
}

/** Increase raster resolution for small sources without changing the logical frame layout. */
export function frameOutputSize(
  width: number,
  height: number,
): { width: number; height: number; scale: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('无效的画框尺寸');
  const scale = Math.max(1, 640 / width);
  const outputWidth = Math.ceil(width * scale);
  const outputHeight = Math.ceil(height * scale);
  if (outputWidth > 16384 || outputHeight > 16384 || outputWidth * outputHeight > 32000000)
    throw new Error('图片超出画框尺寸限制，无法完整生成。');
  return { width: outputWidth, height: outputHeight, scale };
}

export async function renderPhotoFrame(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FRAME_TEMPLATE,
  orientation: FrameOrientation = DEFAULT_FRAME_ORIENTATION,
  resources = new ImageResources(),
  theme: ImageTheme = detectImageTheme(),
): Promise<Blob> {
  const palette = IMAGE_PALETTES[theme];
  if (media.type !== 'photo') throw new Error('只有照片支持生成画框');
  let userText = getFrameText(record, media, template);
  if (!media.originalUrl) throw new Error('当前照片没有可用的原图地址');
  let image: HTMLImageElement | undefined;
  let avatarImage: HTMLImageElement | undefined;
  let brandImage: HTMLImageElement | undefined;
  const canvas = document.createElement('canvas');
  try {
    const loaded = await Promise.allSettled([
      resources.load(browser.runtime.getURL('/icons/icon-48.png')).then((value) => {
        brandImage = value;
      }),
      resources.load(media.originalUrl).then((value) => {
        image = value;
      }),
      userText.includes(FRAME_AVATAR_MARKER)
        ? loadAvatar(record.author.avatarUrl, resources).then((value) => {
            avatarImage = value;
          })
        : Promise.resolve(),
    ]);
    const failed = loaded.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    resources.checkActive();
    if (!image) throw new Error('原图无法解码');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持 Canvas 画框渲染');

    if (
      image.naturalWidth > 16384 ||
      image.naturalHeight > 16384 ||
      image.naturalWidth * image.naturalHeight > 32000000
    ) {
      throw new Error('图片超出画框尺寸限制，无法完整生成。');
    }
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    context.drawImage(image, 0, 0);
    const transparent = hasTransparentPixels(context, image.naturalWidth, image.naturalHeight);
    userText = getFrameText(record, media, template, transparent ? 'webp' : 'jpg');

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

    const logicalWidth = image.naturalWidth;
    const output = frameOutputSize(logicalWidth, image.naturalHeight + layout.barHeight);
    canvas.width = output.width;
    canvas.height = output.height;
    context.scale(output.scale, output.scale);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const imageY = orientation === 'top' ? layout.barHeight : 0;
    context.drawImage(image, 0, imageY, logicalWidth, image.naturalHeight);
    context.fillStyle = palette.background;
    context.fillRect(
      0,
      orientation === 'top' ? 0 : image.naturalHeight,
      logicalWidth,
      layout.barHeight,
    );
    context.fillStyle = palette.text;
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
          brandImage,
        );
      });
      context.textAlign = 'right';
      layout.rightLines.forEach((line, index) => {
        context.globalAlpha = 0.55;
        context.fillStyle = palette.muted;
        context.font = `${index === 0 ? 450 : 550} ${layout.fontSize}px ${FRAME_FONT_FAMILY}`;
        drawHorizontalTextLine(
          context,
          line,
          logicalWidth - layout.paddingX,
          frameY + layout.paddingY + (index + 0.5) * layout.lineHeight,
          layout.fontSize,
          avatarImage,
          brandImage,
        );
      });
      context.globalAlpha = 1;
    } else {
      const frameY = orientation === 'top' ? 0 : image.naturalHeight;
      const measureText = createFrameTextMeasurer(context, layout.fontSize);
      const sourceLineCount = sourceLines.flatMap((line) =>
        wrapFrameText(line, logicalWidth - layout.paddingX * 2, measureText),
      ).length;
      const sourceStart = layout.leftLines.length - sourceLineCount;
      context.textAlign = 'left';
      layout.leftLines.forEach((line, index) => {
        context.globalAlpha = index >= sourceStart ? 0.55 : 1;
        context.fillStyle = index >= sourceStart ? palette.muted : palette.text;
        drawHorizontalTextLine(
          context,
          line,
          layout.paddingX,
          frameY + layout.paddingY + (index + 0.5) * layout.lineHeight,
          layout.fontSize,
          avatarImage,
          brandImage,
        );
      });
    }

    context.globalAlpha = 1;
    context.strokeStyle = palette.border;
    context.lineWidth = 1;
    const frameY = orientation === 'top' ? 0 : image.naturalHeight;
    context.strokeRect(0.5, frameY + 0.5, logicalWidth - 1, layout.barHeight - 1);

    resources.checkActive();
    return await encodeFrame(canvas, transparent);
  } finally {
    if (image) releaseImage(image);
    if (avatarImage) releaseImage(avatarImage);
    if (brandImage) releaseImage(brandImage);
    canvas.width = 0;
    canvas.height = 0;
  }
}
