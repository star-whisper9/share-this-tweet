import type { TweetRecord } from '../shared/model.js';
import { getLocale, t, type Locale } from '../shared/i18n.js';
import type { ExtensionSettings } from '../shared/settings.js';
import { getCardMediaPreview } from './card-media.js';
import { renderImageFrame, type FrameOrientation } from './frame.js';
import { IMAGE_PALETTES, type ImageTheme } from './image-theme.js';
import { ImageResources, releaseImage } from './image-resources.js';

export type StitchStyle = 'seamless' | 'gallery';
interface Size {
  width: number;
  height: number;
}

/** Equal heights, original aspect ratios, and no upscaling or cropping. */
export function calculateStitchLayout(
  images: Size[],
  style: StitchStyle,
  maxWidth = 12000,
  maxHeight = 12000,
  maxPixels = 24000000,
) {
  if (
    !images.length ||
    images.some(
      ({ width, height }) =>
        !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0,
    )
  )
    throw new Error(t('core.stitch.invalidDimensions'));
  const naturalHeight = Math.min(...images.map((image) => image.height));
  const gap = style === 'gallery' ? Math.max(1, Math.round(naturalHeight * 0.012)) : 0;
  const widths = images.map((image) => (image.width / image.height) * naturalHeight);
  const naturalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (images.length - 1);
  const scale = Math.min(
    1,
    maxWidth / naturalWidth,
    maxHeight / naturalHeight,
    Math.sqrt(maxPixels / naturalWidth / naturalHeight),
  );
  const height = naturalHeight * scale;
  let x = 0;
  const rects = widths.map((width) => {
    const rect = { x, y: 0, width: width * scale, height };
    x += rect.width + gap * scale;
    return rect;
  });
  return { width: naturalWidth * scale, height, rects };
}

export async function renderStitchedMedia(
  record: TweetRecord,
  settings: ExtensionSettings,
  theme: ImageTheme,
  resources: ImageResources,
  frame: 'original' | FrameOrientation,
  locale: Locale = getLocale(),
): Promise<Blob> {
  if (record.media.length < 2) throw new Error(t('core.stitch.atLeastTwoMedia', {}, locale));
  const images: HTMLImageElement[] = [];
  const canvas = document.createElement('canvas');
  try {
    for (const media of record.media) {
      const url = getCardMediaPreview(media).url;
      if (!url)
        throw new Error(t('core.stitch.staticImageUnavailable', { index: media.index }, locale));
      images.push(await resources.load(url));
    }
    resources.checkActive();
    const layout = calculateStitchLayout(
      images.map((image) => ({ width: image.naturalWidth, height: image.naturalHeight })),
      settings.stitchStyle,
    );
    canvas.width = Math.max(1, Math.round(layout.width));
    canvas.height = Math.max(1, Math.round(layout.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('core.stitch.canvasUnavailable', {}, locale));
    if (settings.stitchStyle === 'gallery') {
      context.fillStyle = IMAGE_PALETTES[theme].background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    images.forEach((image, index) => {
      const rect = layout.rects[index]!;
      // Shared integer boundaries avoid hairline seams from fractional canvas coverage.
      const left = Math.round(rect.x);
      const right = Math.round(rect.x + rect.width);
      context.drawImage(image, left, 0, right - left, canvas.height);
    });
    // Release decoded originals before allocating the framed output.
    for (const image of images) releaseImage(image);
    images.length = 0;
    if (frame !== 'original')
      return await renderImageFrame(
        record,
        record.media[0]!,
        settings.frameTemplate,
        frame,
        resources,
        theme,
        canvas,
        locale,
      );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => {
        if (!blob || blob.type !== 'image/png')
          reject(new Error(t('core.stitch.imageFailed', {}, locale)));
        else resolve(blob);
      }, 'image/png'),
    );
  } finally {
    for (const image of images) releaseImage(image);
    canvas.width = 0;
    canvas.height = 0;
  }
}
