import { enqueueExportJob, openExportJobs } from '../core/job-client.js';
import { detectCardTheme } from '../core/card.js';
import { copyTweetText } from '../core/text-export.js';
import { recordOutput, saveTweetRecord } from '../core/storage-client.js';
import type { FrameOrientation } from '../core/frame.js';
import type { TweetRecord } from '../shared/model.js';
import type { ExtensionSettings } from '../shared/settings.js';
import type { ExportJobRequest } from '../shared/export-jobs.js';
import { getLocale, t } from '../shared/i18n.js';
import { MediaSelection } from './media-selection.js';

export type ActionStatus = 'idle' | 'loading' | 'success' | 'error';
export interface ActionState {
  status: ActionStatus;
  error?: string;
  queued?: boolean;
}
export interface SheetStatus {
  state: 'loading' | 'ready' | 'error';
  message: string;
}
export type TweetAction = 'copy-text' | 'save-card' | 'save-row-card' | 'stitch-media';
export type MediaMode = 'original' | 'framed' | 'sourced' | 'configured';
export interface MediaSaveOptions {
  photo: 'original' | FrameOrientation;
  video: 'original' | 'sourced' | FrameOrientation;
}
const IDLE: Readonly<ActionState> = Object.freeze({ status: 'idle' });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The page only submits immutable jobs. Disposing it never cancels accepted work. */
export class ExportSession {
  readonly selection = new MediaSelection();
  quoted?: ExportSession;
  private actions = new Map<string, ActionState>();
  private active = true;
  private submitting = false;
  private tweet: TweetRecord;
  private preferences: ExtensionSettings;
  private mediaPreferences: MediaSaveOptions;
  private currentStatus: SheetStatus = { state: 'ready', message: '' };
  private messageFactory?: () => string;
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
        if (this.quoted) {
          this.currentStatus = { ...this.quoted.status };
          this.messageFactory = undefined;
        }
        this.changed();
      });
    }
  }
  get status(): Readonly<SheetStatus> {
    return {
      ...this.currentStatus,
      message: this.messageFactory?.() ?? this.currentStatus.message,
    };
  }
  get record(): TweetRecord {
    return this.tweet;
  }
  get settings(): ExtensionSettings {
    return this.preferences;
  }
  get isSavingBatch(): boolean {
    return this.submitting;
  }
  get mediaOptions(): Readonly<MediaSaveOptions> {
    return this.mediaPreferences;
  }
  action(key: TweetAction): Readonly<ActionState> {
    return this.actions.get(key) ?? IDLE;
  }
  private mediaKey(mode: MediaMode, orientation: FrameOrientation): string {
    return `${mode}:${this.selection
      .selected(this.record.media)
      .map((m) => m.index)
      .join(',')}:${orientation}:${this.mediaPreferences.photo}:${this.mediaPreferences.video}`;
  }
  mediaAction(
    mode: MediaMode,
    orientation = this.settings.frameOrientation,
  ): Readonly<ActionState> {
    return this.actions.get(this.mediaKey(mode, orientation)) ?? IDLE;
  }
  toggleMedia(index: number): void {
    if (!this.active || this.submitting) return;
    this.selection.toggle(index, this.record.media);
    this.changed();
  }
  configureMedia(options: Partial<MediaSaveOptions>): void {
    if (!this.active || this.submitting) return;
    this.mediaPreferences = { ...this.mediaPreferences, ...options };
    if (options.photo !== undefined) this.actions.delete('stitch-media');
    this.changed();
  }
  updateRecord(record: TweetRecord): void {
    if (record.tweetId !== this.tweet.tweetId) throw new Error('A session cannot change its tweet');
    this.tweet = record;
    this.selection.reconcile(record.media);
    this.syncQuote();
  }
  updateSettings(settings: ExtensionSettings): void {
    this.preferences = settings;
    if (!settings.experimentalVideo && ['top', 'bottom'].includes(this.mediaPreferences.video))
      this.mediaPreferences = { ...this.mediaPreferences, video: 'sourced' };
    this.quoted?.updateSettings(settings);
  }
  refreshLocale(): void {
    this.quoted?.refreshLocale();
    this.changed();
  }
  dispose(): void {
    this.active = false;
    this.quoted?.dispose();
  }
  private changed(): void {
    if (this.active) this.onChange();
  }
  private setStatus(state: SheetStatus['state'], message: string, factory?: () => string): void {
    this.currentStatus = { state, message };
    this.messageFactory = factory;
    this.changed();
  }
  async openTasks(): Promise<void> {
    try {
      await openExportJobs();
    } catch (error) {
      if (this.active) this.setStatus('error', errorMessage(error));
    }
  }
  private async submit(key: string, job: ExportJobRequest, count: number): Promise<void> {
    if (!this.active || this.submitting) return;
    this.submitting = true;
    this.actions.set(key, { status: 'loading' });
    this.setStatus('loading', t('jobs.submitting'), () => t('jobs.submitting'));
    try {
      await enqueueExportJob(structuredClone(job));
      if (!this.active) return;
      this.actions.set(key, { status: 'success', queued: true });
      const message = () => t('jobs.queuedMessage', { count });
      this.setStatus('ready', message(), message);
    } catch (error) {
      if (!this.active) return;
      this.actions.set(key, { status: 'error', error: errorMessage(error) });
      this.setStatus('error', t('jobs.enqueueFailed', { error: errorMessage(error) }));
    } finally {
      this.submitting = false;
      this.changed();
    }
  }
  private request(kind: ExportJobRequest['kind']): ExportJobRequest {
    return {
      id: crypto.randomUUID(),
      kind,
      record: this.record,
      settings: this.settings,
      theme: detectCardTheme(),
      locale: getLocale(),
    };
  }
  saveCard(row = false): Promise<void> {
    return this.submit(
      row ? 'save-row-card' : 'save-card',
      this.request(row ? 'row-card' : 'card'),
      1,
    );
  }
  stitchMedia(): Promise<void> {
    return this.submit(
      'stitch-media',
      { ...this.request('stitch'), frame: this.mediaOptions.photo },
      1,
    );
  }
  saveSelected(mode: MediaMode, orientation = this.settings.frameOrientation): Promise<void> {
    const media = this.selection.selected(this.record.media);
    if (!media.length) return Promise.resolve();
    const options = { ...this.mediaOptions };
    const items = media.map((item) => {
      const choice = item.type === 'photo' ? options.photo : options.video;
      const configured = choice === 'top' || choice === 'bottom';
      return {
        index: item.index,
        mode:
          mode === 'configured'
            ? configured
              ? 'framed'
              : (choice as 'original' | 'sourced')
            : mode === 'sourced' && item.type === 'photo'
              ? 'original'
              : mode,
        orientation:
          mode === 'configured' && configured ? (choice as FrameOrientation) : orientation,
      };
    });
    return this.submit(
      this.mediaKey(mode, orientation),
      { ...this.request('media'), media: items },
      items.length,
    );
  }
  async copyText(): Promise<void> {
    if (!this.active || this.actions.get('copy-text')?.status === 'loading') return;
    const record = structuredClone(this.record),
      settings = { ...this.settings },
      locale = getLocale();
    this.actions.set('copy-text', { status: 'loading' });
    this.setStatus('loading', t('content.copyLoading'));
    try {
      await copyTweetText(record, settings.textTemplate, locale);
      let warning: string | undefined;
      try {
        await saveTweetRecord(record);
        await recordOutput({ tweetId: record.tweetId, outputType: 'copied-text' });
      } catch (error) {
        warning = t('content.persistWarning', { error: errorMessage(error) }, locale);
      }
      if (!this.active) return;
      this.actions.set('copy-text', { status: 'success' });
      this.setStatus(
        warning ? 'error' : 'ready',
        warning ?? t('content.copySuccess'),
        warning ? undefined : () => t('content.copySuccess'),
      );
    } catch (error) {
      if (this.active) {
        this.actions.set('copy-text', { status: 'error', error: errorMessage(error) });
        this.setStatus('error', t('content.copyFailure'));
      }
    }
  }
}
