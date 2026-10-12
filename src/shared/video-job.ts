import type { TweetRecord } from './model.js';
import type { Locale } from './i18n.js';
import type { VideoFrame, VideoStitchStyle } from './video-render.js';
import type { ImageTheme } from '../core/image-theme.js';

/** A background export request, before media is fetched for the renderer Worker. */
export interface BackgroundVideoRenderRequest {
  type: 'start';
  id: string;
  record: TweetRecord;
  indexes: number[];
  style: VideoStitchStyle;
  frame: VideoFrame;
  frameTemplate: string;
  theme: ImageTheme;
  locale: Locale;
  outputFormat?: 'mp4' | 'gif';
}
