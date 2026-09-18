import { renderDynamicMedia, type VideoProgress } from '../core/video-client.js';
import { renderStitchedMedia } from '../core/stitch.js';
import {
  buildCardFilename,
  buildStitchFilename,
  buildFrameFilename,
  buildMediaFilename,
  buildSourcedMediaFilename,
} from '../core/filename.js';
import { ImageResources } from '../core/image-resources.js';
import { detectCardTheme, renderTweetCard, type CardTheme } from '../core/card.js';
import { downloadBlob, downloadMedia } from '../core/download.js';
import { renderPhotoFrame, type FrameOrientation } from '../core/frame.js';
import { copyTweetText } from '../core/text-export.js';
import { recordOutput, saveTweetRecord } from '../core/storage-client.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import type { OutputRecordInput } from '../shared/storage-model.js';
import type { ExtensionSettings } from '../shared/settings.js';
import { getLocale, t } from '../shared/i18n.js';
import { createMediaSourceMetadata } from '../shared/media-source.js';
import { MediaSelection } from './media-selection.js';

export type ActionStatus = 'idle' | 'loading' | 'success' | 'error';
export interface ActionState {
  status: ActionStatus;
  error?: string;
}
export interface SheetStatus {
  state: 'loading' | 'ready' | 'error';
  message: string;
}
interface LocalizedSheetStatus extends SheetStatus {
  messageFactory?: () => string;
}
export type TweetAction = 'copy-text' | 'save-card' | 'save-row-card' | 'stitch-media';
export type MediaMode = 'original' | 'framed' | 'sourced' | 'configured';
export interface MediaSaveOptions {
  photo: 'original' | FrameOrientation;
  video: 'original' | 'sourced' | FrameOrientation;
}
interface ActionMessages {
  loading: () => string;
  success: () => string;
  failure: () => string;
}
interface ExportContext {
  theme: CardTheme;
  record: TweetRecord;
  settings: ExtensionSettings;
  locale: ReturnType<typeof getLocale>;
}
const IDLE: Readonly<ActionState> = Object.freeze({ status: 'idle' });
function directionLabel(orientation: FrameOrientation): string {
  return t(orientation === 'top' ? 'content.directionTop' : 'content.directionBottom');
}

function mediaKey(index: number, mode: MediaMode, orientation: FrameOrientation): string {
  if (mode === 'original') return `media:${index}`;
  if (mode === 'sourced') return `source:${index}`;
  return `frame:${index}:${orientation}`;
}
function batchKey(mode: MediaMode, orientation: FrameOrientation): string {
  if (mode === 'original') return 'batch:original';
  if (mode === 'sourced') return 'batch:sourced';
  return `batch:frame:${orientation}`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** State and output orchestration for one tweet. It never reads or writes UI DOM. */
export class ExportSession {
  readonly selection = new MediaSelection();
  quoted?: ExportSession;
  private readonly actions = new Map<string, ActionState>();
  private active = true;
  private batchRunning = false;
  private videoAbort?: AbortController;
  private mediaCancelled = false;
  private cardFile?: File;
  private cardKey?: string;
  private cardPending?: { key: string; promise: Promise<File> };
  private readonly resources = new ImageResources();
  private tweet: TweetRecord;
  private preferences: ExtensionSettings;
  private mediaPreferences: MediaSaveOptions;
  private currentStatus: LocalizedSheetStatus = { state: 'ready', message: '' };

  constructor(
    record: TweetRecord,
    settings: ExtensionSettings,
    private readonly onChange: () => void = () => {},
  ) {
    this.tweet = record;
    this.preferences = settings;
    this.mediaPreferences = { photo: settings.frameOrientation, video: 'sourced' };
    this.selection.reconcile(record.media);
    this.syncQuote();
  }

  private syncQuote(): void {
    const quote = this.tweet.quote?.record;
    if (!quote) {
      this.quoted?.dispose();
      this.quoted = undefined;
      return;
    }
    if (this.quoted?.record.tweetId === quote.tweetId) this.quoted.updateRecord(quote);
    else {
      this.quoted?.dispose();
      this.quoted = new ExportSession(quote, this.preferences, () => {
        if (this.quoted) this.currentStatus = { ...this.quoted.status };
        this.changed();
      });
    }
  }

  get status(): Readonly<SheetStatus> {
    const { messageFactory, ...status } = this.currentStatus;
    return { ...status, message: messageFactory?.() ?? status.message };
  }

  get record(): TweetRecord {
    return this.tweet;
  }

  get settings(): ExtensionSettings {
    return this.preferences;
  }

  get isSavingBatch(): boolean {
    return this.batchRunning || this.isProcessingVideo;
  }

  get isProcessingVideo(): boolean {
    return !!this.videoAbort || !!this.quoted?.isProcessingVideo;
  }

  cancelMediaProcessing(): void {
    this.mediaCancelled = true;
    this.videoAbort?.abort();
    this.quoted?.cancelMediaProcessing();
  }

  private async renderVideo(
    context: ExportContext,
    media: MediaRecord[],
    frame: MediaSaveOptions['photo'],
  ): Promise<Blob> {
    if (this.videoAbort) throw new Error(t('dynamic.busy'));
    const controller = new AbortController();
    this.videoAbort = controller;
    this.changed();
    const onProgress = ({ phase, progress }: VideoProgress): void => {
      const message = () =>
        phase === 'encoding'
          ? t('dynamic.progress.encoding', { percent: Math.round((progress ?? 0) * 100) })
          : t(`dynamic.progress.${phase}`);
      this.setStatus('loading', message(), message);
    };
    try {
      return await renderDynamicMedia(
        context.record,
        media,
        context.settings,
        frame,
        context.theme,
        context.locale,
        { signal: controller.signal, onProgress },
      );
    } finally {
      if (this.videoAbort === controller) this.videoAbort = undefined;
      this.changed();
    }
  }

  get mediaOptions(): Readonly<MediaSaveOptions> {
    return this.mediaPreferences;
  }

  configureMedia(options: Partial<MediaSaveOptions>): void {
    if (!this.active || this.isSavingBatch) return;
    this.mediaPreferences = { ...this.mediaPreferences, ...options };
    if (options.photo !== undefined && this.actions.get('stitch-media')?.status !== 'loading')
      this.actions.delete('stitch-media');
    for (const key of this.actions.keys())
      if (key.startsWith('configured:')) this.actions.delete(key);
    this.changed();
  }

  private configuredKey(): string {
    return `configured:${this.selection
      .selected(this.record.media)
      .map((item) => item.index)
      .join(',')}:${this.mediaOptions.photo}:${this.mediaOptions.video}`;
  }

  action(key: TweetAction): Readonly<ActionState> {
    return this.actions.get(key) ?? IDLE;
  }

  mediaAction(
    mode: MediaMode,
    orientation = this.settings.frameOrientation,
  ): Readonly<ActionState> {
    if (this.selection.size === 0 || this.selection.primary === undefined) return IDLE;
    if (mode === 'configured') return this.actions.get(this.configuredKey()) ?? IDLE;
    const key =
      this.selection.size > 1
        ? batchKey(mode, orientation)
        : mediaKey(this.selection.primary, mode, orientation);
    return this.actions.get(key) ?? IDLE;
  }

  updateRecord(record: TweetRecord): void {
    if (record.tweetId !== this.tweet.tweetId) throw new Error('A session cannot change its tweet');
    if (JSON.stringify(record) !== JSON.stringify(this.tweet)) this.invalidateCard();
    this.tweet = record;
    this.selection.reconcile(record.media);
    this.syncQuote();
  }

  updateSettings(settings: ExtensionSettings): void {
    if (settings.filenameTemplate !== this.preferences.filenameTemplate) this.invalidateCard();
    this.preferences = settings;
    this.quoted?.updateSettings(settings);
  }

  /** Keep the action result visible while deriving its message from the new locale. */
  refreshLocale(): void {
    this.quoted?.refreshLocale();
    this.changed();
  }

  private invalidateCard(): void {
    this.cardFile = undefined;
    this.cardKey = undefined;
    this.cardPending = undefined;
  }

  dispose(): void {
    this.active = false;
    this.videoAbort?.abort();
    this.quoted?.dispose();
    this.cardFile = undefined;
    this.cardPending = undefined;
    this.resources.dispose();
  }

  toggleMedia(index: number): void {
    if (!this.active || this.isSavingBatch) return;
    this.selection.toggle(index, this.record.media);
    for (const key of this.actions.keys()) if (key.startsWith('batch:')) this.actions.delete(key);
    this.changed();
  }

  private changed(): void {
    if (this.active) this.onChange();
  }

  private setStatus(
    state: SheetStatus['state'],
    message: string,
    messageFactory?: () => string,
  ): void {
    this.currentStatus = { state, message, messageFactory };
    this.changed();
  }

  /** All async completions are scoped to this session, including cancel/error paths. */
  private async run(
    key: string,
    messages: ActionMessages,
    operation: (context: ExportContext) => Promise<string | undefined>,
  ): Promise<void> {
    if (!this.active || this.actions.get(key)?.status === 'loading') return;
    const context = {
      record: this.record,
      settings: this.settings,
      theme: detectCardTheme(),
      locale: getLocale(),
    };
    this.actions.set(key, { status: 'loading' });
    this.setStatus('loading', messages.loading(), messages.loading);
    try {
      const warning = await operation(context);
      if (!this.active) return;
      this.actions.set(key, { status: 'success' });
      this.setStatus(
        warning ? 'error' : 'ready',
        warning ?? messages.success(),
        warning ? undefined : messages.success,
      );
    } catch (error) {
      if (!this.active) return;
      this.actions.set(key, { status: 'error', error: errorMessage(error) });
      this.setStatus('error', messages.failure(), messages.failure);
      console.error('分享有据: 输出失败', key, error);
    }
  }

  private async persist(
    record: TweetRecord,
    output: OutputRecordInput,
  ): Promise<string | undefined> {
    if (!this.active) return;
    try {
      await saveTweetRecord(record);
      await recordOutput(output);
      return undefined;
    } catch (error) {
      console.error('分享有据: 来源记录保存失败', error);
      return t('content.persistWarning', { error: errorMessage(error) });
    }
  }

  copyText(): Promise<void> {
    return this.run(
      'copy-text',
      {
        loading: () => t('content.copyLoading'),
        success: () => t('content.copySuccess'),
        failure: () => t('content.copyFailure'),
      },
      async ({ record, settings, locale }) => {
        await copyTweetText(record, settings.textTemplate, locale);
        return this.persist(record, { tweetId: record.tweetId, outputType: 'copied-text' });
      },
    );
  }

  private async getCard(
    { record, settings, theme, locale }: ExportContext,
    row = false,
  ): Promise<File> {
    const filename = buildCardFilename(record, record.media[0], settings.filenameTemplate, row);
    const key = JSON.stringify([
      record,
      theme,
      filename,
      row,
      row ? settings.stitchStyle : undefined,
      locale,
    ]);
    if (this.cardKey === key && this.cardFile) return this.cardFile;
    if (this.cardPending?.key === key) return this.cardPending.promise;
    this.cardFile = undefined;
    this.cardKey = key;
    const promise = (async () => {
      const result = await renderTweetCard(record, record.media, {
        theme,
        resources: this.resources,
        locale,
        ...(row ? { mediaLayout: 'row' as const, stitchStyle: settings.stitchStyle } : {}),
      });
      const file = new File([result.blob], filename, { type: 'image/png' });
      if (this.active && this.cardKey === key && file.size <= 32 * 1024 * 1024)
        this.cardFile = file;
      return file;
    })();
    this.cardPending = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.cardPending?.promise === promise) this.cardPending = undefined;
    }
  }

  private cardOutput(record: TweetRecord, file: File, row: boolean): OutputRecordInput {
    const firstMedia = record.media[0];
    return {
      tweetId: record.tweetId,
      outputType: row ? 'row-tweet-card' : 'tweet-card',
      filename: file.name,
      ...(firstMedia ? { mediaIndex: firstMedia.index } : {}),
    };
  }

  saveCard(row = false): Promise<void> {
    return this.run(
      row ? 'save-row-card' : 'save-card',
      {
        loading: () => t('content.cardLoading'),
        success: () => t('content.cardSuccess'),
        failure: () => t('content.cardFailure'),
      },
      async (context) => {
        const file = await this.getCard(context, row);
        if (!this.active) return;
        downloadBlob(file, file.name);
        return this.persist(context.record, this.cardOutput(context.record, file, row));
      },
    );
  }

  stitchMedia(): Promise<void> {
    const frame = this.mediaOptions.photo;
    return this.run(
      'stitch-media',
      {
        loading: () => t('content.stitchLoading'),
        success: () => t('content.stitchSuccess'),
        failure: () => t('content.stitchFailure'),
      },
      async (context) => {
        const { record, settings, theme, locale } = context;
        const animated = record.media.some((item) => item.type !== 'photo');
        const blob = animated
          ? await this.renderVideo(context, record.media, frame)
          : await renderStitchedMedia(record, settings, theme, this.resources, frame, locale);
        const extension =
          blob.type === 'image/png'
            ? 'png'
            : blob.type === 'image/jpeg'
              ? 'jpg'
              : blob.type === 'image/webp'
                ? 'webp'
                : blob.type === 'video/mp4'
                  ? 'mp4'
                  : undefined;
        if (!extension) throw new Error(t('content.stitchFormatError'));
        const filename = buildStitchFilename(
          record,
          settings.filenameTemplate,
          extension,
          frame !== 'original',
        );
        if (!this.active) return;
        downloadBlob(blob, filename);
        return this.persist(record, {
          tweetId: record.tweetId,
          outputType: animated ? 'stitched-video' : 'stitched-image',
          filename,
        });
      },
    );
  }

  private async exportMedia(
    context: ExportContext,
    media: MediaRecord,
    mode: MediaMode,
    orientation: FrameOrientation,
  ): Promise<string | undefined> {
    const { record, settings } = context;
    let filename: string;
    const framed = mode === 'framed';
    const sourced = mode === 'sourced' && media.type !== 'photo';
    if (framed) {
      const blob =
        media.type === 'photo'
          ? await renderPhotoFrame(
              record,
              media,
              settings.frameTemplate,
              orientation,
              this.resources,
              context.theme,
              undefined,
              context.locale,
            )
          : await this.renderVideo(context, [media], orientation);
      if (!['image/jpeg', 'image/webp', 'video/mp4'].includes(blob.type))
        throw new Error(t('content.frameFormatError'));
      filename = buildFrameFilename(
        record,
        media,
        settings.filenameTemplate,
        blob.type === 'video/mp4' ? 'mp4' : blob.type === 'image/webp' ? 'webp' : 'jpg',
      );
      if (!this.active) return;
      downloadBlob(blob, filename);
    } else {
      filename = sourced
        ? buildSourcedMediaFilename(record, media, settings.filenameTemplate)
        : buildMediaFilename(record, media, settings.filenameTemplate);
      const source = sourced
        ? createMediaSourceMetadata(record, media, browser.runtime.getManifest().version)
        : undefined;
      await downloadMedia(media, filename, source);
    }
    return this.persist(record, {
      tweetId: record.tweetId,
      outputType: framed
        ? media.type === 'photo'
          ? 'framed-image'
          : 'framed-video'
        : sourced
          ? 'sourced-media'
          : 'original-media',
      filename,
      mediaIndex: media.index,
    });
  }

  async saveSelected(mode: MediaMode, orientation = this.settings.frameOrientation): Promise<void> {
    const selected = this.selection.selected(this.record.media);
    if (!this.active || this.isSavingBatch || selected.length === 0) return;
    const batch = selected.length > 1;
    const options = this.mediaOptions;
    if (mode === 'configured' && options.photo !== 'original') orientation = options.photo;
    const key =
      mode === 'configured'
        ? this.configuredKey()
        : batch
          ? batchKey(mode, orientation)
          : mediaKey(selected[0].index, mode, orientation);
    if (this.actions.get(key)?.status === 'loading') return;
    const success = (): string =>
      mode === 'configured'
        ? t('content.mediaSaveSuccess', { count: selected.length })
        : mode === 'framed'
          ? t('content.mediaSaveFrameSuccess', {
              count: selected.length,
              direction: directionLabel(orientation),
            })
          : mode === 'sourced'
            ? t('content.mediaSaveSourceSuccess', { count: selected.length })
            : t('content.mediaSaveOriginalSuccess', { count: selected.length });
    this.mediaCancelled = false;
    this.batchRunning = true;
    try {
      await this.run(
        key,
        {
          loading: () => t('content.mediaSaving'),
          success,
          failure: () => t('content.mediaSaveFailure'),
        },
        async (context) => {
          const failures: string[] = [];
          const warnings: { index: number; message: string }[] = [];
          for (const [index, media] of selected.entries()) {
            if (!this.active) return;
            const videoFrame = options.video === 'top' || options.video === 'bottom';
            const itemMode: MediaMode =
              mode === 'configured'
                ? media.type === 'photo'
                  ? options.photo === 'original'
                    ? 'original'
                    : 'framed'
                  : videoFrame
                    ? 'framed'
                    : (options.video as 'original' | 'sourced')
                : mode === 'sourced' && media.type === 'photo'
                  ? 'original'
                  : mode;
            const itemOrientation =
              mode === 'configured' && media.type !== 'photo' && videoFrame
                ? (options.video as FrameOrientation)
                : orientation;
            const itemKey = mediaKey(media.index, itemMode, itemOrientation);
            try {
              const warning = await this.exportMedia(context, media, itemMode, itemOrientation);
              if (!this.active) return;
              if (warning) warnings.push({ index: media.index, message: warning });
              if (batch) this.actions.set(itemKey, { status: 'success' });
            } catch (error) {
              if (!this.active) return;
              const message = errorMessage(error);
              this.actions.set(itemKey, { status: 'error', error: message });
              if (!batch || this.mediaCancelled) throw error;
              failures.push(t('content.itemFailure', { index: media.index, error: message }));
            }
            const progress = () =>
              t('content.mediaSaveProgress', { current: index + 1, total: selected.length });
            this.setStatus('loading', progress(), progress);
          }
          if (failures.length > 0) throw new Error(failures.join('; '));
          return warnings.length > 0
            ? t('content.partialPersistWarning', {
                success: success(),
                warnings: warnings
                  .map((warning) =>
                    t('content.itemWarning', {
                      index: warning.index,
                      warning: warning.message,
                    }),
                  )
                  .join('; '),
              })
            : undefined;
        },
      );
    } finally {
      this.batchRunning = false;
      this.changed();
    }
  }
}
