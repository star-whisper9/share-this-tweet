import { exceedsImageBudget, IMAGE_BUDGET, STITCH_BUDGET } from '../shared/processing-limit.js';
import type { ExportJobRequest } from '../shared/export-jobs.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';
import { calculateStitchLayout } from './stitch.js';
import { calculateTweetCardLayout } from './card.js';
import { calculateFrameLayout } from './frame.js';
import { renderTemplate } from './template.js';
import { normalizeGifLimits } from '../shared/gif-experiment.js';

/** Metadata estimates avoid downloading or decoding media before the user starts an export. */
export function exportLimitWarnings(
  request: ExportJobRequest,
  measure?: (text: string, fontSize: number) => number,
): string[] {
  if (request.force) return [];
  const { record, settings, locale } = request;
  const warnings = new Set<string>();
  let context: CanvasRenderingContext2D | null | undefined;
  const measureText = (text: string, fontSize: number) => {
    if (measure) return { width: measure(text, fontSize) };
    context ??= document.createElement('canvas').getContext('2d');
    if (!context) throw new Error(t('core.card.canvasUnavailable', {}, locale));
    context.font = `400 ${fontSize}px "SF Pro Display", "Helvetica Neue", system-ui, sans-serif`;
    return context.measureText(text);
  };
  const sized = (media: MediaRecord): media is MediaRecord & { width: number; height: number } =>
    Number.isFinite(media.width) &&
    Number.isFinite(media.height) &&
    media.width! > 0 &&
    media.height! > 0;
  const imageLimit = (width: number, height: number, stitch = false) => {
    if (exceedsImageBudget(width, height, stitch ? STITCH_BUDGET : IMAGE_BUDGET))
      warnings.add(
        t('content.limitImage', { width: Math.ceil(width), height: Math.ceil(height) }, locale),
      );
  };
  const framedHeight = (width: number, height: number, media: MediaRecord) => {
    const fontSize = Math.max(12, Math.min(32, Math.round(width * 0.035)));
    const userText = renderTemplate(
      settings.frameTemplate,
      { tweet: record, media, extension: media.type === 'photo' ? 'jpg' : 'mp4', locale },
      'frameTemplate',
    ).trim();
    const layout = calculateFrameLayout({
      width,
      userText,
      sourceLines: [record.tweetId, t('core.brand', {}, locale)],
      fontSize,
      measureText: (text) => measureText(text, fontSize),
    });
    return height + layout.barHeight;
  };
  const dynamic = (media: MediaRecord[], frame: boolean, gif = false) => {
    const limits = gif ? normalizeGifLimits(settings.gifLimits) : settings.videoLimits;
    const seconds = Math.max(0, ...media.map((item) => (item.durationMs ?? 0) / 1000));
    if (limits.maxDurationSeconds && seconds > limits.maxDurationSeconds)
      warnings.add(t('experiment.limitDuration', { limit: limits.maxDurationSeconds }, locale));
    const maxPixels = gif
      ? normalizeGifLimits(settings.gifLimits).maxSourcePixels
      : settings.videoLimits.maxOutputPixels;
    if (maxPixels && media.some((item) => sized(item) && item.width * item.height > maxPixels))
      warnings.add(t('experiment.limitPixels', { limit: maxPixels }, locale));
    if (media.every(sized)) {
      const layout = calculateStitchLayout(
        media,
        settings.stitchStyle,
        Infinity,
        Infinity,
        Infinity,
      );
      const height = frame ? framedHeight(layout.width, layout.height, media[0]!) : layout.height;
      if (maxPixels && layout.width * height > maxPixels)
        warnings.add(t('experiment.limitPixels', { limit: maxPixels }, locale));
    }
  };
  if (request.kind === 'media') {
    for (const selection of request.media ?? []) {
      const media = record.media.find((item) => item.index === selection.index);
      if (!media) continue;
      if (media.type === 'animated_gif' && settings.experimentalGif !== false)
        dynamic([media], false, true);
      else if (selection.mode === 'framed') {
        if (media.type !== 'photo') dynamic([media], true);
        else if (sized(media)) {
          const scale = Math.max(1, 640 / media.width);
          imageLimit(media.width * scale, framedHeight(media.width, media.height, media) * scale);
        }
      }
    }
  } else if (request.kind === 'stitch') {
    if (settings.experimentalVideo && record.media.some((item) => item.type !== 'photo'))
      dynamic(record.media, request.frame !== 'original');
    else if (record.media.length && record.media.every(sized)) {
      const layout = calculateStitchLayout(
        record.media,
        settings.stitchStyle,
        Infinity,
        Infinity,
        Infinity,
      );
      imageLimit(layout.width, layout.height, true);
      if (request.frame !== 'original')
        imageLimit(layout.width, framedHeight(layout.width, layout.height, record.media[0]!));
    }
  } else {
    const card = (tweet: TweetRecord): { width: number; height: number } | undefined => {
      if (!tweet.media.every(sized)) return;
      const width = Math.max(
        320,
        Math.min(
          1200,
          tweet.media.length ? Math.max(...tweet.media.map((item) => item.width!)) : 800,
        ),
      );
      const fontSize = Math.max(18, Math.min(30, Math.round(width * 0.024)));
      const layout = calculateTweetCardLayout({
        images: tweet.media.map((item) => ({ width: item.width!, height: item.height! })),
        text: tweet.text,
        poll: tweet.poll,
        locale,
        cardWidth: width,
        translation:
          tweet.translation?.status === 'available'
            ? {
                text: tweet.translation.text,
                sourceLanguage: tweet.translation.sourceLanguage ?? '',
              }
            : undefined,
        mediaLayout: request.kind === 'row-card' ? 'row' : 'grid',
        stitchStyle: settings.stitchStyle,
        measureText: (text) => measureText(text, fontSize),
      });
      return { width: layout.width * 2, height: layout.height * 2 };
    };
    const main = card(record);
    if (main) {
      const quote = record.quote?.record ? card(record.quote.record) : undefined;
      imageLimit(main.width, main.height + (quote ? quote.height + 120 : 0));
    }
  }
  return [...warnings];
}
