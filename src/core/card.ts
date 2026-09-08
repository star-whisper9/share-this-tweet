import { ImageResources, loadAvatar, releaseImage } from './image-resources.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { normalizeHandle } from '../shared/model.js';

const CARD_FONT_FAMILY = '"SF Pro Display", "Helvetica Neue", system-ui, sans-serif';
const CARD_MAX_WIDTH = 1200;
const CARD_MIN_WIDTH = 320;
const CARD_TEXT_WIDTH = 800;
const CARD_MAX_SINGLE_IMAGE_HEIGHT = 780;
const CARD_RENDER_SCALE = 2;

export type CardTheme = 'light' | 'dark';

interface CardPalette {
  background: string;
  imageBackground: string;
  text: string;
  muted: string;
  border: string;
}

const CARD_PALETTES: Record<CardTheme, CardPalette> = {
  light: {
    background: '#fbfaf7',
    imageBackground: '#edf0f2',
    text: '#17202a',
    muted: '#687582',
    border: '#dfe3e8',
  },
  dark: {
    background: '#111820',
    imageBackground: '#202b35',
    text: '#f1f4f7',
    muted: '#a9b6c2',
    border: '#354352',
  },
};

export interface CardTextMeasurement {
  measureText(text: string): { width: number };
}

export interface CardImageDimension {
  width: number;
  height: number;
}

export interface CardImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TweetCardLayoutInput extends CardTextMeasurement {
  images: CardImageDimension[];
  text: string;
  cardWidth?: number;
}

export interface TweetCardLayout {
  width: number;
  height: number;
  padding: number;
  contentWidth: number;
  headerHeight: number;
  bodyFontSize: number;
  textLines: string[];
  textLineHeight: number;
  imageY: number;
  imageRects: CardImageRect[];
  imageAreaHeight: number;
  footerHeight: number;
}

export interface TweetCardResult {
  blob: Blob;
  width: number;
  height: number;
}

export function wrapCardText(
  text: string,
  maxWidth: number,
  measureText: CardTextMeasurement['measureText'],
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.trim().split(/\r?\n/)) {
    if (!paragraph) {
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
    if (current) lines.push(current);
  }
  return lines;
}

function validateImageDimensions(images: CardImageDimension[]): void {
  if (images.length > 4) {
    throw new Error('推文卡片最多支持 4 张照片');
  }
  if (
    images.some(
      (image) =>
        !Number.isFinite(image.width) ||
        !Number.isFinite(image.height) ||
        image.width <= 0 ||
        image.height <= 0,
    )
  ) {
    throw new Error('推文卡片需要有效的图片尺寸');
  }
}

export function calculateTweetCardLayout(input: TweetCardLayoutInput): TweetCardLayout {
  validateImageDimensions(input.images);
  const naturalWidth = input.images.length
    ? Math.max(...input.images.map((image) => image.width))
    : CARD_TEXT_WIDTH;
  const width = Math.max(
    CARD_MIN_WIDTH,
    Math.min(CARD_MAX_WIDTH, Math.round(input.cardWidth ?? naturalWidth)),
  );
  const padding = Math.max(16, Math.round(width * 0.03));
  const contentWidth = width - padding * 2;
  const headerHeight = Math.max(48, Math.round(width * 0.05));
  const bodyFontSize = Math.max(18, Math.min(30, Math.round(width * 0.024)));
  const textLineHeight = Math.round(bodyFontSize * 1.42);
  const textLines = input.text.trim()
    ? wrapCardText(input.text, contentWidth, input.measureText)
    : [];
  const gap = Math.max(12, Math.round(width * 0.015));
  const textHeight = textLines.length > 0 ? gap + textLineHeight * textLines.length : 0;
  const imageRects: CardImageRect[] = [];

  if (input.images.length === 1) {
    const image = input.images[0]!;
    const scale = Math.min(
      1,
      contentWidth / image.width,
      CARD_MAX_SINGLE_IMAGE_HEIGHT / image.height,
    );
    const imageWidth = Math.round(image.width * scale);
    const imageHeight = Math.round(image.height * scale);
    imageRects.push({
      x: Math.round((width - imageWidth) / 2),
      y: 0,
      width: imageWidth,
      height: imageHeight,
    });
  } else if (input.images.length > 1) {
    const gridGap = Math.max(10, Math.round(width * 0.012));
    let y = 0;
    for (let index = 0; index < input.images.length; index += 2) {
      const row = input.images.slice(index, index + 2);
      const ratios = row.map((image) => image.width / image.height);
      const available = contentWidth - gridGap * (row.length - 1);
      const rowHeight = Math.min(480, available / ratios.reduce((sum, ratio) => sum + ratio, 0));
      const rowWidth =
        ratios.reduce((sum, ratio) => sum + ratio * rowHeight, 0) + gridGap * (row.length - 1);
      let x = (width - rowWidth) / 2;
      for (const ratio of ratios) {
        const imageWidth = ratio * rowHeight;
        imageRects.push({ x, y, width: imageWidth, height: rowHeight });
        x += imageWidth + gridGap;
      }
      y += rowHeight + gridGap;
    }
  }

  const imageAreaHeight =
    input.images.length === 1
      ? imageRects[0]!.height
      : Math.max(0, ...imageRects.map((rect) => rect.y + rect.height));
  const imageY = padding + headerHeight + textHeight + (input.images.length ? gap : 0);
  const footerHeight = input.images.length ? 30 : 50;
  const height = Math.ceil(imageY + imageAreaHeight + gap + footerHeight + padding);
  return {
    width,
    height,
    padding,
    contentWidth,
    headerHeight,
    bodyFontSize,
    textLines,
    textLineHeight,
    imageY,
    imageRects,
    imageAreaHeight,
    footerHeight,
  };
}

export function resolveCardTheme(explicitMode: string | undefined, systemDark: boolean): CardTheme {
  if (explicitMode?.toLowerCase().includes('dark')) return 'dark';
  if (explicitMode?.toLowerCase().includes('light')) return 'light';
  return systemDark ? 'dark' : 'light';
}

export function detectCardTheme(root: HTMLElement = document.documentElement): CardTheme {
  const explicitMode = [
    root.getAttribute('data-color-mode'),
    root.getAttribute('data-theme'),
    root.ownerDocument.body?.getAttribute('data-color-mode'),
    root.ownerDocument.body?.getAttribute('data-theme'),
  ].find((value) => value);
  const systemDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return resolveCardTheme(explicitMode ?? undefined, systemDark);
}

function drawAvatar(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | undefined,
  x: number,
  y: number,
  size: number,
): void {
  context.save();
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  context.clip();
  if (image) {
    context.drawImage(image, x, y, size, size);
  } else {
    context.fillStyle = '#111111';
    context.fillRect(x, y, size, size);
    context.fillStyle = '#ffffff';
    context.font = `600 ${Math.round(size * 0.58)}px ${CARD_FONT_FAMILY}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('X', x + size / 2, y + size / 2);
  }
  context.restore();
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  rect: CardImageRect,
  palette: CardPalette,
): void {
  context.fillStyle = palette.imageBackground;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(
    image,
    rect.x + (rect.width - width) / 2,
    rect.y + (rect.height - height) / 2,
    width,
    height,
  );
  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('推文卡片 PNG 生成失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

export async function renderTweetCard(
  record: TweetRecord,
  mediaInput: MediaRecord | MediaRecord[],
  options: { theme?: CardTheme; resources?: ImageResources } = {},
): Promise<TweetCardResult> {
  const media = Array.isArray(mediaInput) ? mediaInput : [mediaInput];
  if (media.some((item) => item.type !== 'photo')) {
    throw new Error('推文卡片目前只支持照片');
  }
  if (media.length > 4) {
    throw new Error('推文卡片最多支持 4 张照片');
  }

  const resources = options.resources ?? new ImageResources();
  const images: HTMLImageElement[] = [];
  let canvas: HTMLCanvasElement | undefined;
  let avatar: HTMLImageElement | undefined;
  try {
    // Two photos at a time bound concurrent decoding. Settle all started work before cleanup.
    const results = await Promise.allSettled([
      (async () => {
        for (let index = 0; index < media.length; index += 2) {
          const pair = await Promise.allSettled(
            media.slice(index, index + 2).map(async (item) => {
              if (!item.originalUrl) throw new Error('当前照片没有可用的原图地址');
              return resources.load(item.originalUrl);
            }),
          );
          for (const result of pair) if (result.status === 'fulfilled') images.push(result.value);
          const failed = pair.find((result) => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        }
      })(),
      loadAvatar(record.author.avatarUrl, resources).then((image) => {
        avatar = image;
      }),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    resources.checkActive();
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持 Canvas 推文卡片渲染');

    const theme = options.theme ?? detectCardTheme();
    const palette = CARD_PALETTES[theme];
    const estimatedWidth = Math.max(
      CARD_MIN_WIDTH,
      Math.min(
        CARD_MAX_WIDTH,
        images.length ? Math.max(...images.map((image) => image.naturalWidth)) : CARD_TEXT_WIDTH,
      ),
    );
    const bodyFontSize = Math.max(18, Math.min(30, Math.round(estimatedWidth * 0.024)));
    context.font = `400 ${bodyFontSize}px ${CARD_FONT_FAMILY}`;
    const layout = calculateTweetCardLayout({
      images: images.map((image) => ({ width: image.naturalWidth, height: image.naturalHeight })),
      text: record.text,
      measureText: (text) => context.measureText(text),
    });
    const pixelWidth = layout.width * CARD_RENDER_SCALE;
    const pixelHeight = layout.height * CARD_RENDER_SCALE;
    if (
      !Number.isFinite(pixelWidth) ||
      !Number.isFinite(pixelHeight) ||
      pixelWidth > 16384 ||
      pixelHeight > 16384 ||
      pixelWidth * pixelHeight > 32000000
    ) {
      throw new Error('推文内容超出卡片尺寸限制，无法完整生成。');
    }
    canvas.width = pixelWidth;
    canvas.height = layout.height * CARD_RENDER_SCALE;
    context.scale(CARD_RENDER_SCALE, CARD_RENDER_SCALE);
    context.fillStyle = palette.background;
    context.fillRect(0, 0, layout.width, layout.height);

    const avatarSize = Math.min(56, Math.max(40, Math.round(layout.headerHeight * 0.72)));
    const avatarY = layout.padding + Math.round((layout.headerHeight - avatarSize) / 2);
    drawAvatar(context, avatar, layout.padding, avatarY, avatarSize);
    const authorX = layout.padding + avatarSize + Math.round(layout.padding * 0.35);
    context.fillStyle = palette.text;
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.font = `600 ${Math.round(bodyFontSize * 0.9)}px ${CARD_FONT_FAMILY}`;
    context.fillText(record.author.name || '未知作者', authorX, avatarY + 2);
    context.fillStyle = palette.muted;
    context.font = `400 ${Math.round(bodyFontSize * 0.62)}px ${CARD_FONT_FAMILY}`;
    context.fillText(
      normalizeHandle(record.author.handle),
      authorX,
      avatarY + Math.round(bodyFontSize * 1.2),
    );
    if (record.publishedAt) {
      context.textAlign = 'right';
      context.fillText(
        new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }).format(new Date(record.publishedAt)),
        layout.width - layout.padding,
        avatarY + Math.round(bodyFontSize * 0.65),
      );
    }

    context.textAlign = 'left';
    context.fillStyle = palette.text;
    context.font = `400 ${layout.bodyFontSize}px ${CARD_FONT_FAMILY}`;
    layout.textLines.forEach((line, index) => {
      context.fillText(
        line,
        layout.padding,
        layout.padding +
          layout.headerHeight +
          Math.max(12, Math.round(layout.width * 0.015)) +
          index * layout.textLineHeight,
      );
    });

    images.forEach((image, index) => {
      const rect = layout.imageRects[index]!;
      drawContainedImage(context, image, { ...rect, y: rect.y + layout.imageY }, palette);
    });

    const footerY = layout.height - layout.padding - layout.footerHeight;
    context.fillStyle = palette.muted;
    context.font = `500 ${Math.max(13, Math.round(bodyFontSize * 0.62))}px ${CARD_FONT_FAMILY}`;
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    context.fillText(
      `Tweet ID ${record.tweetId}`,
      layout.padding,
      footerY + layout.footerHeight / 2,
    );
    context.textAlign = 'right';
    context.fillText(
      normalizeHandle(record.author.handle),
      layout.width - layout.padding,
      footerY + layout.footerHeight / 2,
    );

    if (media.length === 0) {
      context.textAlign = 'left';
      context.font = `400 ${Math.max(13, Math.round(bodyFontSize * 0.62))}px ${CARD_FONT_FAMILY}`;
      context.fillText(
        record.url,
        layout.padding,
        footerY + layout.footerHeight - 4,
        layout.contentWidth,
      );
    }

    resources.checkActive();
    const blob = await canvasToBlob(canvas);
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    for (const image of images) releaseImage(image);
    if (avatar) releaseImage(avatar);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!options.resources) resources.dispose();
  }
}
