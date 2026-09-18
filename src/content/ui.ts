import { getTweetIdFromPath, type TweetRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  watchLanguage,
  type ExtensionSettings,
} from '../shared/settings.js';
import { TweetSource } from './tweet-source.js';
import { ExportSession } from './export-session.js';
import { ShareSheet } from './share-sheet.js';
import {
  findPrimaryArticle,
  localizeEntry,
  mountEntry,
  observeTweetPage,
  type TweetEntry,
} from './tweet-page.js';

/** Coordinates the current X detail page; views and exports own their own state. */
export class ShareEnhancerController {
  private started = false;
  private syncQueued = false;
  private currentTweetId?: string;
  private currentArticle?: HTMLElement;
  private entry?: TweetEntry;
  private sheet?: ShareSheet;
  private session?: ExportSession;
  private recordRequestId = 0;
  private settingsRequestId = 0;
  private settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  private stopObservingPage?: () => void;
  private unsubscribeTweetSource?: () => void;
  private unwatchLanguage?: () => void;

  constructor(private readonly tweetSource: TweetSource) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeTweetSource = this.tweetSource.subscribe((record) => {
      if (record.tweetId === this.currentTweetId) this.applyTweetRecord(record);
    });
    this.unwatchLanguage = watchLanguage(() => {
      if (this.entry) localizeEntry(this.entry.button);
      this.session?.refreshLocale();
      this.sheet?.relocalize();
      void this.loadSettings();
    });
    this.stopObservingPage = observeTweetPage(() => this.scheduleSync());
    this.sync();
    void this.loadSettings();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.settingsRequestId += 1;
    this.unsubscribeTweetSource?.();
    this.unsubscribeTweetSource = undefined;
    this.stopObservingPage?.();
    this.stopObservingPage = undefined;
    this.unwatchLanguage?.();
    this.unwatchLanguage = undefined;
    this.removeEntry();
  }

  private scheduleSync(): void {
    if (!this.started || this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      if (this.started) this.sync();
    });
  }

  private sync(): void {
    const tweetId = getTweetIdFromPath(location.pathname);
    const article = tweetId ? findPrimaryArticle(tweetId) : undefined;
    if (!tweetId || !article) {
      this.removeEntry();
      return;
    }
    if (this.currentTweetId === tweetId && this.currentArticle === article) return;
    this.removeEntry();
    this.currentTweetId = tweetId;
    this.currentArticle = article;
    this.entry = mountEntry(article, () => this.sheet?.open());
    this.sheet = new ShareSheet(tweetId, this.entry.button, () => {
      void this.loadSettings();
    });
    void this.resolveTweetRecord(tweetId);
  }

  private async resolveTweetRecord(tweetId: string): Promise<void> {
    const requestId = ++this.recordRequestId;
    const isCurrent = (): boolean =>
      requestId === this.recordRequestId && this.currentTweetId === tweetId;
    const existing = this.tweetSource.get(tweetId);
    if (existing) {
      this.applyTweetRecord(existing);
      return;
    }
    this.sheet?.setStatus('loading', t('content.readingTweetData'));
    this.entry?.button.setAttribute('aria-busy', 'true');
    try {
      const record = await this.tweetSource.waitFor(tweetId);
      if (isCurrent()) this.applyTweetRecord(record);
    } catch (error) {
      if (!isCurrent()) return;
      this.sheet?.setStatus(
        'error',
        error instanceof Error ? error.message : t('content.couldNotReadTweet'),
      );
      console.error('分享有据: 推文读取失败', error);
    } finally {
      if (isCurrent()) this.entry?.button.removeAttribute('aria-busy');
    }
  }

  private applyTweetRecord(record: TweetRecord): void {
    if (this.session) this.session.updateRecord(record);
    else {
      const session = new ExportSession(record, this.settings, () => {
        if (this.session === session) this.sheet?.render(session);
      });
      this.session = session;
    }
    this.sheet?.render(this.session);
  }

  private async loadSettings(): Promise<void> {
    const requestId = ++this.settingsRequestId;
    try {
      const settings = await loadSettings();
      if (!this.started || requestId !== this.settingsRequestId) return;
      this.settings = settings;
      if (this.entry) localizeEntry(this.entry.button);
      this.sheet?.relocalize();
      if (this.session) {
        this.session.updateSettings(settings);
        this.sheet?.render(this.session);
      }
    } catch (error) {
      if (!this.started || requestId !== this.settingsRequestId) return;
      console.error('分享有据: 设置读取失败', error);
      this.sheet?.setStatus('error', t('content.settingsReadFailed'));
    }
  }

  private removeEntry(): void {
    this.recordRequestId += 1;
    this.session?.dispose();
    this.session = undefined;
    this.sheet?.destroy();
    this.sheet = undefined;
    this.entry?.host.remove();
    this.entry = undefined;
    this.currentTweetId = undefined;
    this.currentArticle = undefined;
  }
}
