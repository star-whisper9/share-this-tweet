import { IMAGE_PALETTES, detectImageTheme, type ImageTheme } from './image-theme.js';
import { ImageResources, loadAvatar, releaseImage, type LoadedAvatar } from './image-resources.js';
import { getLocale, t, type Locale } from '../shared/i18n.js';
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
  const minLeftWidth = Math.max(
    fontSize * 6,
    input.measureText(t('core.frame.templateMeasure')).width,
  );
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
  locale: Locale = getLocale(),
): string {
  const context = { tweet: record, media, extension };
  return renderTemplate(template, {
    ...context,
    avatarMarker: FRAME_AVATAR_MARKER,
    locale,
  }).trim();
}

function getSourceLines(record: TweetRecord, locale: Locale): string[] {
  return [record.tweetId, `${FRAME_BRAND_MARKER}${t('core.brand', {}, locale)}`];
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
  avatarImage?: LoadedAvatar,
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

export function encodeFrame(
  canvas: HTMLCanvasElement,
  transparent: boolean,
  locale: Locale = getLocale(),
): Promise<Blob> {
  const type = transparent ? 'image/webp' : 'image/jpeg';
  return encodeCanvas(canvas, type, locale, 0.92);
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  locale: Locale,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== type) {
          reject(new Error(t('core.frame.imageFailed', { type }, locale)));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

/** Increase raster resolution for small sources without changing the logical frame layout. */
export function frameOutputSize(
  width: number,
  height: number,
): { width: number; height: number; scale: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error(t('core.frame.invalidDimensions'));
  const scale = Math.max(1, 640 / width);
  const outputWidth = Math.ceil(width * scale);
  const outputHeight = Math.ceil(height * scale);
  if (outputWidth > 16384 || outputHeight > 16384 || outputWidth * outputHeight > 32000000)
    throw new Error(t('core.frame.imageTooLarge'));
  return { width: outputWidth, height: outputHeight, scale };
}

function drawFrameContent(
  context: CanvasRenderingContext2D,
  layout: FrameLayout,
  sourceLines: string[],
  frameY: number,
  palette: (typeof IMAGE_PALETTES)[ImageTheme],
  avatarImage?: LoadedAvatar,
  brandImage?: HTMLImageElement,
): void {
  context.fillStyle = palette.background;
  context.fillRect(0, frameY, layout.width, layout.barHeight);
  context.fillStyle = palette.text;
  context.font = `500 ${layout.fontSize}px ${FRAME_FONT_FAMILY}`;
  // Each line occupies a fixed-height cell. Centering the glyph in that cell
  // keeps the same paddingY on both sides of a top or bottom frame, regardless
  // of the font's ascent/descent metrics.
  context.textBaseline = 'middle';

  if (layout.mode === 'double') {
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
        layout.width - layout.paddingX,
        frameY + layout.paddingY + (index + 0.5) * layout.lineHeight,
        layout.fontSize,
        avatarImage,
        brandImage,
      );
    });
    context.globalAlpha = 1;
  } else {
    const measureText = createFrameTextMeasurer(context, layout.fontSize);
    const sourceLineCount = sourceLines.flatMap((line) =>
      wrapFrameText(line, layout.width - layout.paddingX * 2, measureText),
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
  context.strokeRect(0.5, frameY + 0.5, layout.width - 1, layout.barHeight - 1);
}

export async function renderImageFrame(
  record: TweetRecord,
  media: MediaRecord,
  template = DEFAULT_FRAME_TEMPLATE,
  orientation: FrameOrientation = DEFAULT_FRAME_ORIENTATION,
  resources = new ImageResources(),
  theme: ImageTheme = detectImageTheme(),
  source?: HTMLCanvasElement,
  locale: Locale = getLocale(),
): Promise<Blob> {
  const palette = IMAGE_PALETTES[theme];
  if (!source && media.type !== 'photo') throw new Error(t('core.frame.photoOnly', {}, locale));
  let userText = getFrameText(record, media, template, 'jpg', locale);
  if (!source && !media.originalUrl)
    throw new Error(t('core.frame.originalUnavailable', {}, locale));
  let image: HTMLImageElement | undefined;
  let avatarImage: LoadedAvatar | undefined;
  let brandImage: HTMLImageElement | undefined;
  const canvas = document.createElement('canvas');
  try {
    const loaded = await Promise.allSettled([
      resources.load(browser.runtime.getURL('/icons/icon-48.png')).then((value) => {
        brandImage = value;
      }),
      source
        ? Promise.resolve()
        : resources.load(media.originalUrl!).then((value) => {
            image = value;
          }),
      userText.includes(FRAME_AVATAR_MARKER)
        ? loadAvatar(record.author.avatarUrl, resources, palette.text).then((value) => {
            avatarImage = value;
          })
        : Promise.resolve(),
    ]);
    const failed = loaded.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    resources.checkActive();
    const drawable = source ?? image;
    if (!drawable) throw new Error(t('core.frame.decodeFailed', {}, locale));
    const imageWidth = 'naturalWidth' in drawable ? drawable.naturalWidth : drawable.width;
    const imageHeight = 'naturalHeight' in drawable ? drawable.naturalHeight : drawable.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('core.frame.canvasUnavailable', {}, locale));

    if (imageWidth > 16384 || imageHeight > 16384 || imageWidth * imageHeight > 32000000) {
      throw new Error(t('core.frame.imageTooLarge', {}, locale));
    }
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    context.drawImage(drawable, 0, 0);
    const transparent = hasTransparentPixels(context, imageWidth, imageHeight);
    userText = getFrameText(record, media, template, transparent ? 'webp' : 'jpg', locale);

    const sourceLines = getSourceLines(record, locale);
    const fontSize = Math.max(12, Math.min(32, Math.round(imageWidth * 0.035)));
    context.font = `500 ${fontSize}px ${FRAME_FONT_FAMILY}`;
    const layout = calculateFrameLayout({
      width: imageWidth,
      userText,
      sourceLines,
      fontSize,
      orientation,
      measureText: createFrameTextMeasurer(context, fontSize),
    });

    const logicalWidth = imageWidth;
    const output = frameOutputSize(logicalWidth, imageHeight + layout.barHeight);
    canvas.width = output.width;
    canvas.height = output.height;
    context.scale(output.scale, output.scale);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const imageY = orientation === 'top' ? layout.barHeight : 0;
    context.drawImage(drawable, 0, imageY, logicalWidth, imageHeight);
    drawFrameContent(
      context,
      layout,
      sourceLines,
      orientation === 'top' ? 0 : imageHeight,
      palette,
      avatarImage,
      brandImage,
    );

    resources.checkActive();
    return await encodeFrame(canvas, transparent, locale);
  } finally {
    if (image) releaseImage(image);
    if (avatarImage) releaseImage(avatarImage);
    if (brandImage) releaseImage(brandImage);
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Render the static credit strip used by an FFmpeg-composited animated frame.
 * The caller places it above or below the video stream and therefore owns orientation.
 */
export async function renderFrameStrip(
  record: TweetRecord,
  media: MediaRecord,
  width: number,
  template: string,
  resources: ImageResources,
  theme: ImageTheme,
  locale: Locale = getLocale(),
): Promise<{ blob: Blob; width: number; height: number }> {
  if (!Number.isInteger(width) || width <= 0)
    throw new Error(t('core.frame.invalidDimensions', {}, locale));
  if (width > 16384) throw new Error(t('core.frame.imageTooLarge', {}, locale));

  const palette = IMAGE_PALETTES[theme];
  const userText = getFrameText(record, media, template, 'mp4', locale);
  const sourceLines = getSourceLines(record, locale);
  let avatarImage: LoadedAvatar | undefined;
  let brandImage: HTMLImageElement | undefined;
  const canvas = document.createElement('canvas');
  try {
    const loaded = await Promise.allSettled([
      resources.load(browser.runtime.getURL('/icons/icon-48.png')).then((value) => {
        brandImage = value;
      }),
      userText.includes(FRAME_AVATAR_MARKER)
        ? loadAvatar(record.author.avatarUrl, resources, palette.text).then((value) => {
            avatarImage = value;
          })
        : Promise.resolve(),
    ]);
    const failed = loaded.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    resources.checkActive();

    canvas.width = width;
    // The frame layout depends on text measurement at the final video width.
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('core.frame.canvasUnavailable', {}, locale));
    const fontSize = Math.max(12, Math.min(32, Math.round(width * 0.035)));
    context.font = `500 ${fontSize}px ${FRAME_FONT_FAMILY}`;
    const layout = calculateFrameLayout({
      width,
      userText,
      sourceLines,
      fontSize,
      measureText: createFrameTextMeasurer(context, fontSize),
    });
    // yuv420p video outputs require both dimensions to be even. Keep the text
    // layout unchanged and extend the background/border by at most one pixel.
    const stripLayout =
      layout.barHeight % 2 === 0 ? layout : { ...layout, barHeight: layout.barHeight + 1 };
    if (stripLayout.barHeight > 16384 || width * stripLayout.barHeight > 32000000)
      throw new Error(t('core.frame.imageTooLarge', {}, locale));
    canvas.height = stripLayout.barHeight;
    drawFrameContent(context, stripLayout, sourceLines, 0, palette, avatarImage, brandImage);
    resources.checkActive();
    return {
      blob: await encodeCanvas(canvas, 'image/png', locale),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    if (avatarImage) releaseImage(avatarImage);
    if (brandImage) releaseImage(brandImage);
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Add a source frame to an original photo. */
export const renderPhotoFrame = renderImageFrame;
