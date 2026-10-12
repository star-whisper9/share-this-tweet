import { calculateStitchLayout, type StitchStyle } from './stitch.js';
import { tagRunsForLines, type CardTextRun } from './card-tags.js';
import { wrapText } from './text-wrap.js';
import { languageName } from '../shared/translation.js';
import { getLocale, t, type Locale } from '../shared/i18n.js';
import {
  IMAGE_PALETTES as CARD_PALETTES,
  detectImageTheme as detectCardTheme,
  type ImageTheme as CardTheme,
  type ImagePalette as CardPalette,
} from './image-theme.js';
export {
  detectImageTheme as detectCardTheme,
  resolveImageTheme as resolveCardTheme,
} from './image-theme.js';
export type { ImageTheme as CardTheme } from './image-theme.js';
import {
  ImageResources,
  loadAvatar,
  loadMonochromeIcon,
  releaseImage,
  type LoadedAvatar,
} from './image-resources.js';
import { formatCardMediaDuration, getCardMediaPreview } from './card-media.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { normalizeHandle } from '../shared/model.js';
import {
  pollFooter,
  pollLabels,
  pollPercentage,
  pollResultsVisible,
  type TweetPoll,
} from '../shared/poll.js';

const CARD_FONT_FAMILY = '"SF Pro Display", "Helvetica Neue", system-ui, sans-serif';
const CARD_MAX_WIDTH = 1200;
const CARD_MIN_WIDTH = 320;
const CARD_TEXT_WIDTH = 800;
const CARD_MAX_SINGLE_IMAGE_HEIGHT = 780;
const CARD_RENDER_SCALE = 2;

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
  translation?: { text: string; sourceLanguage: string };
  poll?: TweetPoll;
  measureLabelText?: CardTextMeasurement['measureText'];
  cardWidth?: number;
  mediaLayout?: 'grid' | 'row';
  stitchStyle?: StitchStyle;
  locale?: Locale;
}

export interface TweetCardLayout {
  width: number;
  height: number;
  padding: number;
  contentWidth: number;
  headerHeight: number;
  bodyFontSize: number;
  labelFontSize: number;
  labelLineHeight: number;
  textLines: string[];
  bodyLines: Array<{
    text: string;
    y: number;
    icon?: 'grok' | 'x';
    label?: boolean;
    runs?: CardTextRun[];
  }>;
  pollBlocks: CardPollLayout[];
  textLineHeight: number;
  imageY: number;
  imageRects: CardImageRect[];
  imageAreaHeight: number;
  footerHeight: number;
}

export interface CardPollLayout {
  y: number;
  height: number;
  heading: string;
  translated: boolean;
  optionPadding: number;
  selectionWidth: number;
  options: Array<{
    index: number;
    y: number;
    height: number;
    labelWidth: number;
    lines: string[];
    selected: boolean;
    percentage?: number;
  }>;
  footerY: number;
  footerLines: string[];
}

export interface TweetCardResult {
  blob: Blob;
  width: number;
  height: number;
}

interface CardRenderOptions {
  theme?: CardTheme;
  resources?: ImageResources;
  mediaLayout?: 'grid' | 'row';
  stitchStyle?: StitchStyle;
  locale?: Locale;
}

interface LoadedCardMedia {
  media: MediaRecord;
  preview: ReturnType<typeof getCardMediaPreview>;
  image?: HTMLImageElement;
}

export function wrapCardText(
  text: string,
  maxWidth: number,
  measureText: CardTextMeasurement['measureText'],
): string[] {
  return wrapText(text.trim(), maxWidth, measureText);
}

function validateImageDimensions(images: CardImageDimension[]): void {
  if (images.length > 4) {
    throw new Error(t('core.card.maxPhotos'));
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
    throw new Error(t('core.card.invalidImageDimensions'));
  }
}

function cardWidthForImages(images: CardImageDimension[], requestedWidth?: number): number {
  const naturalWidth = images.length
    ? Math.max(...images.map((image) => image.width))
    : CARD_TEXT_WIDTH;
  return Math.max(CARD_MIN_WIDTH, Math.min(CARD_MAX_WIDTH, requestedWidth ?? naturalWidth));
}

function cardTextSizes(width: number) {
  const bodyFontSize = Math.max(18, Math.min(30, Math.round(width * 0.024)));
  const labelFontSize = Math.max(12, Math.round(bodyFontSize * 0.7));
  return {
    bodyFontSize,
    labelFontSize,
    textLineHeight: Math.round(bodyFontSize * 1.42),
    labelLineHeight: Math.round(labelFontSize * 1.5),
  };
}

export function calculateTweetCardLayout(input: TweetCardLayoutInput): TweetCardLayout {
  if (input.poll?.status === 'invalid') throw new Error(t('core.poll.invalid', {}, input.locale));
  validateImageDimensions(input.images);
  const width = Math.round(cardWidthForImages(input.images, input.cardWidth));
  const padding = Math.max(16, Math.round(width * 0.03));
  const contentWidth = width - padding * 2;
  const headerHeight = Math.max(48, Math.round(width * 0.05));
  const { bodyFontSize, textLineHeight, labelFontSize, labelLineHeight } = cardTextSizes(width);
  const gap = Math.max(12, Math.round(width * 0.015));
  const measureLabelText =
    input.measureLabelText ??
    ((value: string) => ({
      width: (input.measureText(value).width * labelFontSize) / bodyFontSize,
    }));
  const bodyLines: TweetCardLayout['bodyLines'] = [];
  const pollBlocks: CardPollLayout[] = [];
  let bodyY = padding + headerHeight + gap;
  const appendLine = (line: Omit<TweetCardLayout['bodyLines'][number], 'y'>) => {
    bodyLines.push({ ...line, y: bodyY });
    bodyY += line.label ? labelLineHeight : textLineHeight;
  };
  const appendText = (text: string) => {
    if (!text.trim()) return;
    const lines = wrapCardText(text, contentWidth, input.measureText);
    const runs = tagRunsForLines(text, lines);
    lines.forEach((text, index) => appendLine({ text, runs: runs[index] }));
  };
  const appendLabel = (text: string, icon: 'grok' | 'x') => {
    wrapCardText(text, contentWidth - labelFontSize * 1.4, measureLabelText).forEach(
      (text, index) => appendLine({ text, label: true, ...(index === 0 ? { icon } : {}) }),
    );
  };
  const appendPoll = (translated: boolean) => {
    const poll = input.poll;
    if (!poll || poll.status !== 'available') return;
    if (bodyLines.length || pollBlocks.length) bodyY += gap;
    const y = bodyY;
    const optionPadding = Math.max(10, Math.round(bodyFontSize * 0.6));
    const selectionWidth = Math.round(bodyFontSize * 1.4);
    const resultsVisible =
      pollResultsVisible(poll) && poll.options.every((option) => option.votes !== undefined);
    const percentageWidth = resultsVisible
      ? Math.max(bodyFontSize * 3.5, input.measureText('100.0%').width) + optionPadding
      : 0;
    const labelWidth = contentWidth - optionPadding * 2 - selectionWidth - percentageWidth;
    const labels = pollLabels(poll, translated);
    bodyY += labelLineHeight + optionPadding;
    const options = poll.options.map((option, index) => {
      const lines = wrapCardText(labels[index]!, labelWidth, input.measureText);
      const height = Math.max(1, lines.length) * textLineHeight + optionPadding * 2;
      const result = {
        index: option.index,
        y: bodyY,
        height,
        labelWidth,
        lines,
        selected: poll.selectedChoice === option.index,
        ...(resultsVisible ? { percentage: pollPercentage(poll, option.index) } : {}),
      };
      bodyY += height + optionPadding;
      return result;
    });
    const footerY = bodyY;
    const footerLines = wrapCardText(
      pollFooter(poll, input.locale),
      contentWidth,
      measureLabelText,
    );
    bodyY += footerLines.length * labelLineHeight;
    pollBlocks.push({
      y,
      height: bodyY - y,
      heading: t('core.poll.heading', {}, input.locale),
      translated,
      optionPadding,
      selectionWidth,
      options,
      footerY,
      footerLines,
    });
  };
  if (input.translation) {
    appendLabel(
      t('core.translation.from', { language: input.translation.sourceLanguage }, input.locale),
      'grok',
    );
    appendText(input.translation.text);
    if (input.poll?.status === 'available' && input.poll.translation?.status === 'available')
      appendPoll(true);
    appendLine({ text: '' });
    appendLabel(t('core.translation.original', {}, input.locale), 'x');
  }
  appendText(input.text);
  appendPoll(false);
  const textLines = bodyLines.map((line) => line.text);
  const textHeight = bodyLines.length || pollBlocks.length ? bodyY - padding - headerHeight : 0;
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
    if (input.mediaLayout === 'row') {
      const row = calculateStitchLayout(
        input.images,
        input.stitchStyle ?? 'seamless',
        contentWidth,
        CARD_MAX_SINGLE_IMAGE_HEIGHT,
      );
      imageRects.push(
        ...row.rects.map((rect) => ({ ...rect, x: rect.x + (width - row.width) / 2 })),
      );
    } else {
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
  }

  const imageAreaHeight =
    input.images.length === 1
      ? imageRects[0]!.height
      : Math.max(0, ...imageRects.map((rect) => rect.y + rect.height));
  const imageY = padding + headerHeight + textHeight + (input.images.length ? gap : 0);
  const footerHeight = 0;
  const height = Math.ceil(imageY + imageAreaHeight + gap + footerHeight + padding);
  return {
    width,
    height,
    padding,
    contentWidth,
    headerHeight,
    bodyFontSize,
    labelFontSize,
    labelLineHeight,
    textLines,
    bodyLines,
    pollBlocks,
    textLineHeight,
    imageY,
    imageRects,
    imageAreaHeight,
    footerHeight,
  };
}

function drawAvatar(
  context: CanvasRenderingContext2D,
  image: LoadedAvatar | undefined,
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

function drawPoll(
  context: CanvasRenderingContext2D,
  block: CardPollLayout,
  layout: TweetCardLayout,
  palette: CardPalette,
  theme: CardTheme,
  locale?: Locale,
): void {
  const accent = theme === 'dark' ? '#8cc8f5' : '#559bd2';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.fillStyle = palette.muted;
  context.font = `600 ${layout.labelFontSize}px ${CARD_FONT_FAMILY}`;
  context.fillText(block.heading, layout.padding, block.y);
  const centeredBaseline = (lines: string[], centerY: number): number => {
    const metrics = lines.map((line) => context.measureText(line || 'Mg'));
    const ascent = Math.max(...metrics.map((metric) => metric.actualBoundingBoxAscent));
    const descent = Math.max(...metrics.map((metric) => metric.actualBoundingBoxDescent));
    return centerY - ((lines.length - 1) * layout.textLineHeight + ascent + descent) / 2 + ascent;
  };
  for (const option of block.options) {
    const x = layout.padding;
    context.fillStyle = palette.imageBackground;
    context.fillRect(x, option.y, layout.contentWidth, option.height);
    if (option.percentage !== undefined) {
      context.save();
      context.globalAlpha = option.selected ? 0.3 : 0.18;
      context.fillStyle = accent;
      context.fillRect(x, option.y, (layout.contentWidth * option.percentage) / 100, option.height);
      context.restore();
    }
    context.strokeStyle = option.selected ? accent : palette.border;
    context.lineWidth = option.selected ? 2 : 1;
    context.strokeRect(x + 0.5, option.y + 0.5, layout.contentWidth - 1, option.height - 1);
    const centerY = option.y + option.height / 2;
    if (option.selected) {
      const checkX = x + block.optionPadding;
      const checkY = centerY - layout.bodyFontSize * 0.125;
      context.strokeStyle = accent;
      context.lineWidth = Math.max(2, layout.bodyFontSize * 0.12);
      context.beginPath();
      context.moveTo(checkX, checkY);
      context.lineTo(checkX + layout.bodyFontSize * 0.25, checkY + layout.bodyFontSize * 0.25);
      context.lineTo(checkX + layout.bodyFontSize * 0.65, checkY - layout.bodyFontSize * 0.25);
      context.stroke();
    }
    context.font = `400 ${layout.bodyFontSize}px ${CARD_FONT_FAMILY}`;
    context.fillStyle = palette.text;
    context.textBaseline = 'alphabetic';
    // Center the visible glyphs, including a wrapped label's complete text block.
    const textY = centeredBaseline(option.lines, centerY);
    option.lines.forEach((line, index) =>
      context.fillText(
        line,
        x + block.optionPadding + block.selectionWidth,
        textY + index * layout.textLineHeight,
      ),
    );
    if (option.percentage !== undefined) {
      context.textAlign = 'right';
      context.font = `600 ${layout.bodyFontSize}px ${CARD_FONT_FAMILY}`;
      const percentage = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(option.percentage)}%`;
      context.fillText(
        percentage,
        x + layout.contentWidth - block.optionPadding,
        centeredBaseline([percentage], centerY),
      );
      context.textAlign = 'left';
    }
  }
  context.textBaseline = 'top';
  context.fillStyle = palette.muted;
  context.font = `400 ${layout.labelFontSize}px ${CARD_FONT_FAMILY}`;
  block.footerLines.forEach((line, index) =>
    context.fillText(line, layout.padding, block.footerY + index * layout.labelLineHeight),
  );
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

function drawMediaPlaceholder(
  context: CanvasRenderingContext2D,
  rect: CardImageRect,
  palette: CardPalette,
  media: MediaRecord,
  locale: Locale,
): void {
  context.fillStyle = palette.imageBackground;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.fillStyle = palette.muted;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `400 ${Math.max(12, Math.round(Math.min(rect.width, rect.height) * 0.06))}px ${CARD_FONT_FAMILY}`;
  context.fillText(
    media.type === 'animated_gif'
      ? t('core.card.gifPreviewUnavailable', {}, locale)
      : t('core.card.videoPreviewUnavailable', {}, locale),
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  );
  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
}

function drawMediaBadge(
  context: CanvasRenderingContext2D,
  rect: CardImageRect,
  media: MediaRecord,
  previewLoaded: boolean,
): void {
  const scale = Math.min(1, rect.width / 44, rect.height / 44);
  context.save();
  if (media.type === 'video' && previewLoaded) {
    const radius = 22 * scale;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    context.fillStyle = 'rgba(0, 0, 0, 0.62)';
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(x - radius * 0.24, y - radius * 0.44);
    context.lineTo(x - radius * 0.24, y + radius * 0.44);
    context.lineTo(x + radius * 0.48, y);
    context.closePath();
    context.fill();
  }
  const label = media.type === 'animated_gif' ? 'GIF' : formatCardMediaDuration(media.durationMs);
  if (label) {
    const fontSize = Math.max(8, Math.round(12 * scale));
    context.font = `600 ${fontSize}px ${CARD_FONT_FAMILY}`;
    const padding = Math.max(3, 6 * scale);
    const metrics = context.measureText(label);
    const width = metrics.width + padding * 2;
    const height = fontSize + padding * 2;
    if (width > rect.width - 8 || height > rect.height - 8) {
      context.restore();
      return;
    }
    const x = rect.x + rect.width - width - 8 * scale;
    const y = rect.y + rect.height - height - 8 * scale;
    context.fillStyle = 'rgba(0, 0, 0, 0.7)';
    context.fillRect(x, y, width, height);
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + width / 2, y + height / 2);
  }
  context.restore();
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(t('core.card.pngFailed')));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

/** The caller owns each decoded image, including successful loads before a failure. */
async function loadCardMedia(
  cardMedia: LoadedCardMedia[],
  resources: ImageResources,
  mediaLayout: CardRenderOptions['mediaLayout'],
  locale: Locale | undefined,
): Promise<void> {
  for (let index = 0; index < cardMedia.length; index += 2) {
    const pairMedia = cardMedia.slice(index, index + 2);
    const pair = await Promise.allSettled(
      pairMedia.map(async (item) => {
        if (!item.preview.url) {
          if (item.media.type === 'photo' || mediaLayout === 'row')
            throw new Error(
              t('core.card.staticImageUnavailable', { index: item.media.index }, locale),
            );
          return;
        }
        const image = await resources.load(item.preview.url);
        item.preview.width = image.naturalWidth;
        item.preview.height = image.naturalHeight;
        item.image = image;
      }),
    );
    for (const [pairIndex, result] of pair.entries()) {
      if (
        result.status === 'rejected' &&
        (pairMedia[pairIndex]!.media.type === 'photo' || mediaLayout === 'row')
      )
        throw result.reason;
    }
  }
}

function drawCardBody(
  context: CanvasRenderingContext2D,
  layout: TweetCardLayout,
  palette: CardPalette,
  theme: CardTheme,
  locale: Locale | undefined,
  grokIcon?: HTMLCanvasElement,
  xIcon?: HTMLCanvasElement,
): void {
  context.textAlign = 'left';
  context.fillStyle = palette.text;
  context.font = `400 ${layout.bodyFontSize}px ${CARD_FONT_FAMILY}`;
  layout.bodyLines.forEach((line) => {
    const y = line.y;
    const fontSize = line.label ? layout.labelFontSize : layout.bodyFontSize;
    context.font = `400 ${fontSize}px ${CARD_FONT_FAMILY}`;
    const icon = line.icon === 'grok' ? grokIcon : line.icon === 'x' ? xIcon : undefined;
    context.fillStyle = line.label ? palette.muted : palette.text;
    if (icon) context.drawImage(icon, layout.padding, y, fontSize, fontSize);
    if (line.runs) {
      for (const run of line.runs) {
        context.fillStyle = run.tag ? (theme === 'dark' ? '#8cc8f5' : '#559bd2') : palette.text;
        context.fillText(
          run.text,
          layout.padding + context.measureText(line.text.slice(0, run.start)).width,
          y,
        );
      }
    } else {
      context.fillText(line.text, layout.padding + (line.icon ? fontSize * 1.4 : 0), y);
    }
  });
  layout.pollBlocks.forEach((block) => drawPoll(context, block, layout, palette, theme, locale));
}

async function renderCardCanvas(
  record: TweetRecord,
  mediaInput: MediaRecord | MediaRecord[],
  options: CardRenderOptions & { cardWidth?: number } = {},
): Promise<HTMLCanvasElement> {
  if (record.poll?.status === 'invalid')
    throw new Error(t('core.poll.invalid', {}, options.locale));
  const media = Array.isArray(mediaInput) ? mediaInput : [mediaInput];
  if (media.length > 4) {
    throw new Error(t('core.card.maxMedia', {}, options.locale));
  }

  const resources = options.resources ?? new ImageResources();
  const theme = options.theme ?? detectCardTheme();
  const palette = CARD_PALETTES[theme];
  const translation = record.translation?.status === 'available' ? record.translation : undefined;
  let grokIcon: HTMLCanvasElement | undefined;
  let xIcon: HTMLCanvasElement | undefined;
  const cardMedia: LoadedCardMedia[] = media.map((item) => ({
    media: item,
    preview: getCardMediaPreview(item),
  }));
  let canvas: HTMLCanvasElement | undefined;
  let avatar: LoadedAvatar | undefined;
  let completed = false;
  try {
    // Two preview images at a time bound concurrent decoding. Video/GIF previews
    // use a visible slot in grid cards; row cards require every preview to load.
    const results = await Promise.allSettled([
      loadCardMedia(cardMedia, resources, options.mediaLayout, options.locale),
      loadAvatar(record.author.avatarUrl, resources, palette.text).then((image) => {
        avatar = image;
      }),
      translation
        ? loadMonochromeIcon('grok.svg', resources, palette.muted).then((icon) => {
            grokIcon = icon;
          })
        : Promise.resolve(),
      translation
        ? loadMonochromeIcon('x.svg', resources, palette.muted).then((icon) => {
            xIcon = icon;
          })
        : Promise.resolve(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    resources.checkActive();
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('core.card.canvasUnavailable', {}, options.locale));

    const { bodyFontSize, labelFontSize } = cardTextSizes(
      cardWidthForImages(
        cardMedia.map((item) => item.preview),
        options.cardWidth,
      ),
    );
    context.font = `400 ${bodyFontSize}px ${CARD_FONT_FAMILY}`;
    const layout = calculateTweetCardLayout({
      images: cardMedia.map((item) => ({ width: item.preview.width, height: item.preview.height })),
      text: record.text,
      poll: record.poll,
      translation: translation
        ? {
            text: translation.text,
            sourceLanguage:
              languageName(
                translation.sourceLanguage,
                translation.sourceLanguageName,
                options.locale,
              ) || t('core.translation.unknownLanguage', {}, options.locale),
          }
        : undefined,
      cardWidth: options.cardWidth,
      mediaLayout: options.mediaLayout,
      stitchStyle: options.stitchStyle,
      locale: options.locale,
      measureText: (text) => context.measureText(text),
      measureLabelText: (text) => {
        context.save();
        context.font = `400 ${labelFontSize}px ${CARD_FONT_FAMILY}`;
        const measured = context.measureText(text);
        context.restore();
        return measured;
      },
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
      throw new Error(t('core.card.contentTooLarge', {}, options.locale));
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
    context.fillText(
      record.author.name || t('core.card.unknownAuthor', {}, options.locale),
      authorX,
      avatarY + 2,
    );
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
        new Intl.DateTimeFormat(options.locale, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }).format(new Date(record.publishedAt)),
        layout.width - layout.padding,
        avatarY + Math.round(bodyFontSize * 0.65),
      );
    }

    drawCardBody(context, layout, palette, theme, options.locale, grokIcon, xIcon);

    cardMedia.forEach((item, index) => {
      const rect = layout.imageRects[index]!;
      const positionedRect = { ...rect, y: rect.y + layout.imageY };
      if (item.image && options.mediaLayout === 'row') {
        const left = Math.round(positionedRect.x * CARD_RENDER_SCALE) / CARD_RENDER_SCALE;
        const right =
          Math.round((positionedRect.x + positionedRect.width) * CARD_RENDER_SCALE) /
          CARD_RENDER_SCALE;
        context.drawImage(item.image, left, positionedRect.y, right - left, positionedRect.height);
      } else if (item.image) drawContainedImage(context, item.image, positionedRect, palette);
      else
        drawMediaPlaceholder(
          context,
          positionedRect,
          palette,
          item.media,
          options.locale ?? getLocale(),
        );
      if (item.media.type !== 'photo')
        drawMediaBadge(context, positionedRect, item.media, !!item.image);
    });

    resources.checkActive();
    completed = true;
    return canvas;
  } finally {
    for (const item of cardMedia) if (item.image) releaseImage(item.image);
    if (avatar) releaseImage(avatar);
    if (grokIcon) releaseImage(grokIcon);
    if (xIcon) releaseImage(xIcon);
    if (canvas && !completed) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!options.resources) resources.dispose();
  }
}

/** Compose exactly one quoted post, without re-encoding intermediate canvases. */
export async function renderTweetCard(
  record: TweetRecord,
  mediaInput: MediaRecord | MediaRecord[],
  options: CardRenderOptions = {},
): Promise<TweetCardResult> {
  const locale = options.locale ?? getLocale();
  options = { ...options, locale };
  const resources = options.resources ?? new ImageResources();
  const theme = options.theme ?? detectCardTheme();
  const canvases: HTMLCanvasElement[] = [];
  let brand: HTMLImageElement | undefined;
  try {
    const main = await renderCardCanvas(record, mediaInput, { ...options, theme, resources });
    canvases.push(main);
    let output = main;
    if (record.quote) {
      const quote = record.quote;
      const inset = 24 * CARD_RENDER_SCALE;
      const heading = 36 * CARD_RENDER_SCALE;
      const quoted = quote.record
        ? await renderCardCanvas(quote.record, quote.record.media, {
            ...options,
            theme,
            resources,
            cardWidth: (main.width - inset * 2) / CARD_RENDER_SCALE,
          })
        : undefined;
      if (quoted) canvases.push(quoted);
      // Very narrow cards may require fitting the minimum-width quoted card to the container.
      const quoteWidth = main.width - inset * 2;
      const quoteHeight = quoted
        ? Math.ceil((quoted.height * quoteWidth) / quoted.width)
        : 100 * CARD_RENDER_SCALE;
      const height = main.height + heading + quoteHeight + inset;
      if (height > 16384 || main.width * height > 32000000)
        throw new Error(t('core.card.quoteTooLarge', {}, locale));
      output = document.createElement('canvas');
      canvases.push(output);
      output.width = main.width;
      output.height = height;
      const context = output.getContext('2d');
      if (!context) throw new Error(t('core.card.canvasUnavailable', {}, locale));
      const palette = CARD_PALETTES[theme];
      context.fillStyle = palette.background;
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(main, 0, 0);
      context.fillStyle = palette.muted;
      context.font = `600 ${14 * CARD_RENDER_SCALE}px ${CARD_FONT_FAMILY}`;
      context.fillText(
        t('core.card.quoteHeading', {}, locale),
        inset,
        main.height + 22 * CARD_RENDER_SCALE,
      );
      const y = main.height + heading;
      if (quoted) context.drawImage(quoted, inset, y, quoteWidth, quoteHeight);
      else {
        context.font = `400 ${14 * CARD_RENDER_SCALE}px ${CARD_FONT_FAMILY}`;
        context.fillText(
          quote.status === 'unavailable'
            ? t('core.text.quoteUnavailable', {}, locale)
            : t('core.text.quotePending', {}, locale),
          inset + 16,
          y + 40,
          quoteWidth - 32,
        );
        if (quote.tweetId)
          context.fillText(
            `https://x.com/i/status/${quote.tweetId}`,
            inset + 16,
            y + 84,
            quoteWidth - 32,
          );
      }
      context.strokeStyle = palette.border;
      context.lineWidth = CARD_RENDER_SCALE;
      context.strokeRect(inset, y, quoteWidth, quoteHeight);
    }
    brand = await resources.load(browser.runtime.getURL('/icons/icon-48.png'));
    const footer = document.createElement('canvas');
    canvases.push(footer);
    const context = footer.getContext('2d');
    if (!context) throw new Error(t('core.card.canvasUnavailable', {}, locale));
    const scale = CARD_RENDER_SCALE;
    const padding = 20 * scale;
    const font = `400 ${11 * scale}px ${CARD_FONT_FAMILY}`;
    context.font = font;
    const sources = [record, ...(record.quote ? [record.quote] : [])];
    const lines = sources.flatMap((source, index) => {
      const id = source.tweetId;
      const url =
        source.url ??
        (id ? `https://x.com/i/status/${id}` : t('core.card.sourceUnavailable', {}, locale));
      return wrapCardText(
        `${sources.length > 1 ? `[${index + 1}] ` : ''}${url}`,
        output.width - padding * 2,
        (value) => context.measureText(value),
      );
    });
    const lineHeight = 16 * scale;
    const footHeight = padding + lines.length * lineHeight + 26 * scale;
    const height = output.height + footHeight;
    if (height > 16384 || output.width * height > 32000000)
      throw new Error(t('core.card.footnoteTooLarge', {}, locale));
    footer.width = output.width;
    footer.height = height;
    const palette = CARD_PALETTES[theme];
    context.fillStyle = palette.background;
    context.fillRect(0, 0, footer.width, footer.height);
    context.drawImage(output, 0, 0);
    context.globalAlpha = 0.55;
    context.strokeStyle = palette.border;
    context.beginPath();
    context.moveTo(padding, output.height);
    context.lineTo(footer.width - padding, output.height);
    context.stroke();
    context.fillStyle = palette.muted;
    context.font = font;
    context.textBaseline = 'top';
    lines.forEach((line, index) =>
      context.fillText(line, padding, output.height + 10 * scale + index * lineHeight),
    );
    const brandY = height - 22 * scale;
    context.drawImage(brand, padding, brandY, 12 * scale, 12 * scale);
    context.fillText(t('core.brand', {}, locale), padding + 17 * scale, brandY);
    output = footer;
    resources.checkActive();
    const blob = await canvasToBlob(output);
    return { blob, width: output.width, height: output.height };
  } finally {
    if (brand) releaseImage(brand);
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!options.resources) resources.dispose();
  }
}
