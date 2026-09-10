import {
  buildCardFilename,
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
export type TweetAction = 'copy-text' | 'save-card';
export type MediaMode = 'original' | 'framed' | 'sourced';
interface ActionMessages {
  loading: string;
  success: string;
  failure: string;
}
interface ExportContext {
  theme: CardTheme;
  record: TweetRecord;
  settings: ExtensionSettings;
}
const IDLE: Readonly<ActionState> = Object.freeze({ status: 'idle' });
const directionLabels: Record<FrameOrientation, string> = { top: '上方', bottom: '下方' };

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
  private cardFile?: File;
  private cardKey?: string;
  private cardPending?: { key: string; promise: Promise<File> };
  private readonly resources = new ImageResources();
  private tweet: TweetRecord;
  private preferences: ExtensionSettings;
  private currentStatus: SheetStatus = { state: 'ready', message: '' };

  constructor(
    record: TweetRecord,
    settings: ExtensionSettings,
    private readonly onChange: () => void = () => {},
  ) {
    this.tweet = record;
    this.preferences = settings;
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
    return this.currentStatus;
  }

  get record(): TweetRecord {
    return this.tweet;
  }

  get settings(): ExtensionSettings {
    return this.preferences;
  }

  get isSavingBatch(): boolean {
    return this.batchRunning;
  }

  action(key: TweetAction): Readonly<ActionState> {
    return this.actions.get(key) ?? IDLE;
  }

  mediaAction(
    mode: MediaMode,
    orientation = this.settings.frameOrientation,
  ): Readonly<ActionState> {
    if (this.selection.size === 0 || this.selection.primary === undefined) return IDLE;
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

  private invalidateCard(): void {
    this.cardFile = undefined;
    this.cardKey = undefined;
    this.cardPending = undefined;
  }

  dispose(): void {
    this.active = false;
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

  private setStatus(state: SheetStatus['state'], message: string): void {
    this.currentStatus = { state, message };
    this.changed();
  }

  /** All async completions are scoped to this session, including cancel/error paths. */
  private async run(
    key: string,
    messages: ActionMessages,
    operation: (context: ExportContext) => Promise<string | undefined>,
  ): Promise<void> {
    if (!this.active || this.actions.get(key)?.status === 'loading') return;
    const context = { record: this.record, settings: this.settings, theme: detectCardTheme() };
    this.actions.set(key, { status: 'loading' });
    this.setStatus('loading', messages.loading);
    try {
      const warning = await operation(context);
      if (!this.active) return;
      this.actions.set(key, { status: 'success' });
      this.setStatus(warning ? 'error' : 'ready', warning ?? messages.success);
    } catch (error) {
      if (!this.active) return;
      this.actions.set(key, { status: 'error', error: errorMessage(error) });
      this.setStatus('error', messages.failure);
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
      return `当前操作已完成，但来源记录保存失败：${errorMessage(error)}`;
    }
  }

  copyText(): Promise<void> {
    return this.run(
      'copy-text',
      {
        loading: '正在复制推文文本…',
        success: '已复制，可直接粘贴到聊天中。',
        failure: '这次没能复制，请查看详情后重试。',
      },
      async ({ record, settings }) => {
        await copyTweetText(record, settings.textTemplate);
        return this.persist(record, { tweetId: record.tweetId, outputType: 'copied-text' });
      },
    );
  }

  private async getCard({ record, settings, theme }: ExportContext): Promise<File> {
    const filename = buildCardFilename(record, record.media[0], settings.filenameTemplate);
    const key = JSON.stringify([record, theme, filename]);
    if (this.cardKey === key && this.cardFile) return this.cardFile;
    if (this.cardPending?.key === key) return this.cardPending.promise;
    this.cardFile = undefined;
    this.cardKey = key;
    const promise = (async () => {
      const result = await renderTweetCard(record, record.media, {
        theme,
        resources: this.resources,
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

  private cardOutput(record: TweetRecord, file: File): OutputRecordInput {
    const firstMedia = record.media[0];
    return {
      tweetId: record.tweetId,
      outputType: 'tweet-card',
      filename: file.name,
      ...(firstMedia ? { mediaIndex: firstMedia.index } : {}),
    };
  }

  saveCard(): Promise<void> {
    return this.run(
      'save-card',
      {
        loading: '正在保存推文卡片…',
        success: '推文卡片已保存。',
        failure: '推文卡片保存失败，请查看详情后重试。',
      },
      async (context) => {
        const file = await this.getCard(context);
        if (!this.active) return;
        downloadBlob(file, file.name);
        return this.persist(context.record, this.cardOutput(context.record, file));
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
    const framed = mode === 'framed' && media.type === 'photo';
    const sourced = mode === 'sourced' && media.type !== 'photo';
    if (framed) {
      const blob = await renderPhotoFrame(
        record,
        media,
        settings.frameTemplate,
        orientation,
        this.resources,
        context.theme,
      );
      if (blob.type !== 'image/jpeg' && blob.type !== 'image/webp')
        throw new Error('画框输出格式不正确');
      filename = buildFrameFilename(
        record,
        media,
        settings.filenameTemplate,
        blob.type === 'image/webp' ? 'webp' : 'jpg',
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
      outputType: framed ? 'framed-image' : sourced ? 'sourced-media' : 'original-media',
      filename,
      mediaIndex: media.index,
    });
  }

  async saveSelected(mode: MediaMode, orientation = this.settings.frameOrientation): Promise<void> {
    const selected = this.selection.selected(this.record.media);
    if (!this.active || this.isSavingBatch || selected.length === 0) return;
    const batch = selected.length > 1;
    const key = batch
      ? batchKey(mode, orientation)
      : mediaKey(selected[0].index, mode, orientation);
    if (this.actions.get(key)?.status === 'loading') return;
    const success =
      mode === 'framed'
        ? `已交给浏览器保存，共 ${selected.length} 项媒体；照片带${directionLabels[orientation]}画框，视频和 GIF 原样保存。`
        : mode === 'sourced'
          ? `已交给浏览器保存，共 ${selected.length} 项媒体；视频和 GIF 已写入来源，照片原样保存。`
          : `已交给浏览器保存，共 ${selected.length} 项原始媒体。`;
    this.batchRunning = batch;
    try {
      await this.run(
        key,
        { loading: '正在保存媒体…', success, failure: '媒体保存失败，请查看详情后重试。' },
        async (context) => {
          const failures: string[] = [];
          const warnings: string[] = [];
          for (const [index, media] of selected.entries()) {
            if (!this.active) return;
            const itemMode =
              mode === 'framed' && media.type === 'photo'
                ? 'framed'
                : mode === 'sourced' && media.type !== 'photo'
                  ? 'sourced'
                  : 'original';
            const itemKey = mediaKey(media.index, itemMode, orientation);
            try {
              const warning = await this.exportMedia(context, media, mode, orientation);
              if (!this.active) return;
              if (warning) warnings.push(`第 ${media.index} 项：${warning}`);
              if (batch) this.actions.set(itemKey, { status: 'success' });
            } catch (error) {
              if (!this.active) return;
              const message = errorMessage(error);
              this.actions.set(itemKey, { status: 'error', error: message });
              if (!batch) throw error;
              failures.push(`第 ${media.index} 项：${message}`);
            }
            this.setStatus('loading', `正在保存已选媒体（${index + 1}/${selected.length}）…`);
          }
          if (failures.length > 0) throw new Error(failures.join('；'));
          return warnings.length > 0
            ? `${success}但部分来源记录保存失败：${warnings.join('；')}`
            : undefined;
        },
      );
    } finally {
      this.batchRunning = false;
      this.changed();
    }
  }
}
