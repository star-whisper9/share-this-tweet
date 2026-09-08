import { buildCardFilename, buildFrameFilename, buildMediaFilename } from '../core/filename.js';
import { renderTweetCard } from '../core/card.js';
import {
  downloadBlob,
  downloadMedia as downloadMediaFile,
  isAndroidUserAgent,
} from '../core/download.js';
import { FRAME_ORIENTATIONS, renderPhotoFrame, type FrameOrientation } from '../core/frame.js';
import { buildTweetText, copyTweetText } from '../core/text-export.js';
import {
  canShareFile,
  ShareCancelledError,
  ShareFailedError,
  shareImage,
  shareText,
} from '../core/share.js';
import { recordOutput, saveTweetRecord } from '../core/storage-client.js';
import { getTweetIdFromPath } from '../shared/model.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import type { OutputRecordInput } from '../shared/storage-model.js';
import { DEFAULT_SETTINGS, loadSettings, type ExtensionSettings } from '../shared/settings.js';
import { TweetSource } from './tweet-source.js';

const ROUTE_CHANGE_EVENT = 'share-this-tweet:route-change';
const ACTION_HOST_ATTRIBUTE = 'data-stt-action-host';
const SHEET_ID = 'stt-bottom-sheet';

type MediaActionState = 'idle' | 'loading' | 'success' | 'error';
type BatchDownloadMode = 'original' | 'framed';
type IconName =
  'share' | 'close' | 'frame' | 'download' | 'copy' | 'photo' | 'video' | 'check' | 'arrow';
const FRAME_ORIENTATION_LABELS: Record<FrameOrientation, string> = { top: '上方', bottom: '下方' };
const ICON_PATHS: Record<IconName, string> = {
  share: 'M13 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M4 16h16M15 3h6v6M21 3l-8 8',
  close: 'M6 6l12 12M18 6L6 18',
  frame:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 16h18M7 12l3-3 4 4 3-3 4 4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  copy: 'M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3',
  photo:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 16l6-6 6 6 3-3 3 3M15 7h.01',
  video: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM10 8l6 4-6 4Z',
  check: 'M5 12l4 4L19 6',
  arrow: 'M7 17 17 7M7 7h10v10',
};
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function extensionIcon(size: 'small' | 'brand'): HTMLImageElement {
  const image = document.createElement('img');
  image.className = size === 'brand' ? 'stt-brand-icon' : 'stt-extension-icon';
  image.src = browser.runtime.getURL(
    size === 'brand' ? '/icons/icon-48.png' : '/icons/icon-32.png',
  );
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  return image;
}
// Only use already-known media on X's image host (or local generated previews).
function thumbnailURL(media: MediaRecord): string | undefined {
  if (media.type !== 'photo' || !media.originalUrl) return undefined;
  try {
    const url = new URL(media.originalUrl, location.href);
    if (url.protocol === 'blob:' && url.origin === location.origin) return url.href;
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com') return undefined;
    url.searchParams.set('name', 'small');
    return url.href;
  } catch {
    return undefined;
  }
}
function sourceURL(record: TweetRecord): string {
  try {
    const url = new URL(record.url || '');
    if (
      url.protocol === 'https:' &&
      ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
    )
      return url.href;
  } catch {
    /* Fall back to the stable post identifier. */
  }
  return `https://x.com/i/status/${encodeURIComponent(record.tweetId)}`;
}

export class ShareEnhancerController {
  private started = false;
  private syncQueued = false;
  private currentTweetId?: string;
  private currentArticle?: HTMLElement;
  private actionHost?: HTMLElement;
  private trigger?: HTMLButtonElement;
  private sheet?: HTMLElement;
  private previousFocus?: HTMLElement;
  private observer?: MutationObserver;
  private restoreHistory?: () => void;
  private closeTimer?: number;
  private recordRequestId = 0;
  private currentRecord?: TweetRecord;
  private readonly mediaActionStates = new Map<number, MediaActionState>();
  private readonly mediaActionErrors = new Map<number, string>();
  private readonly frameActionStates = new Map<string, MediaActionState>();
  private readonly frameActionErrors = new Map<string, string>();
  private textActionState: MediaActionState = 'idle';
  private textActionError = '';
  private textShareState: MediaActionState = 'idle';
  private textShareError = '';
  private imageShareState: MediaActionState = 'idle';
  private imageShareError = '';
  private generatedCardFile?: File;
  private cardSaveState: MediaActionState = 'idle';
  private cardSaveError = '';
  private selectedMediaIndex?: number;
  private readonly selectedMediaIndexes = new Set<number>();
  private mediaSelectionInitialized = false;
  private batchDownloadMode?: BatchDownloadMode;
  private batchOriginalState: MediaActionState = 'idle';
  private batchOriginalError = '';
  private readonly batchFrameStates: Record<FrameOrientation, MediaActionState> = {
    top: 'idle',
    bottom: 'idle',
  };
  private readonly batchFrameErrors: Record<FrameOrientation, string> = { top: '', bottom: '' };
  private restoreOverlay?: () => void;
  private settingsRequestId = 0;
  private settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  private unsubscribeTweetSource?: () => void;

  constructor(private readonly tweetSource: TweetSource) {}

  private readonly onRouteChange = (): void => {
    this.scheduleSync();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.sheet || this.sheet.hidden || this.sheet.dataset.state === 'closing') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeSheet();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = this.focusableElements();
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      this.sheet.querySelector<HTMLElement>('.stt-sheet')?.focus();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first || !this.sheet.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !this.sheet.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  private readonly onFocusIn = (event: FocusEvent): void => {
    if (
      this.sheet &&
      !this.sheet.hidden &&
      this.sheet.dataset.state !== 'closing' &&
      event.target instanceof Node &&
      !this.sheet.contains(event.target)
    ) {
      this.sheet
        .querySelector<HTMLButtonElement>('[data-stt-close]')
        ?.focus({ preventScroll: true });
    }
  };
  private focusableElements(): HTMLElement[] {
    return Array.from(
      this.sheet?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], summary, [tabindex="0"]',
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0 && !item.closest('[hidden]'));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeTweetSource = this.tweetSource.subscribe((record) => {
      if (record.tweetId === this.currentTweetId) this.applyTweetRecord(record);
    });

    this.installRouteListeners();
    this.observer = new MutationObserver(() => this.scheduleSync());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('focusin', this.onFocusIn);
    this.sync();
    void this.loadSettings();
  }

  private async loadSettings(): Promise<void> {
    const requestId = ++this.settingsRequestId;
    try {
      const settings = await loadSettings();
      if (!this.started || requestId !== this.settingsRequestId) return;
      this.settings = settings;
      if (this.currentRecord) this.renderActions(this.currentRecord);
    } catch (error) {
      console.error('分享有据 · Share This Tweet: failed to load settings', error);
      this.setSheetStatus('error', '暂时无法读取新设置，沿用上次可用的模板。');
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeTweetSource?.();
    this.unsubscribeTweetSource = undefined;
    this.restoreHistory?.();
    this.restoreHistory = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    window.removeEventListener('popstate', this.onRouteChange);
    window.removeEventListener(ROUTE_CHANGE_EVENT, this.onRouteChange);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('focusin', this.onFocusIn);
    this.removeEntry();
  }

  private installRouteListeners(): void {
    window.addEventListener('popstate', this.onRouteChange);
    window.addEventListener(ROUTE_CHANGE_EVENT, this.onRouteChange);

    const previousPushState = history.pushState;
    const previousReplaceState = history.replaceState;
    const notifyRouteChange = (): void => {
      window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
    };

    history.pushState = ((...args: Parameters<History['pushState']>) => {
      previousPushState.apply(history, args);
      notifyRouteChange();
    }) as History['pushState'];

    history.replaceState = ((...args: Parameters<History['replaceState']>) => {
      previousReplaceState.apply(history, args);
      notifyRouteChange();
    }) as History['replaceState'];

    this.restoreHistory = (): void => {
      history.pushState = previousPushState;
      history.replaceState = previousReplaceState;
    };
  }

  private scheduleSync(): void {
    if (!this.started || this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      this.sync();
    });
  }

  private sync(): void {
    const tweetId = getTweetIdFromPath(location.pathname);
    if (!tweetId) {
      this.removeEntry();
      return;
    }

    const article = this.findPrimaryArticle(tweetId);
    if (!article) {
      this.removeEntry();
      return;
    }

    if (this.currentTweetId === tweetId && this.currentArticle === article) {
      return;
    }

    this.removeEntry();
    this.currentTweetId = tweetId;
    this.currentArticle = article;
    this.mountEntry(article, tweetId);
    void this.resolveTweetRecord(tweetId);
  }

  private async resolveTweetRecord(tweetId: string): Promise<void> {
    const requestId = ++this.recordRequestId;
    const existing = this.tweetSource.get(tweetId);
    if (existing) {
      this.applyTweetRecord(existing);
      return;
    }

    this.setSheetStatus('loading', '正在读取当前推文数据…');
    this.trigger?.setAttribute('aria-busy', 'true');
    try {
      const record = await this.tweetSource.waitFor(tweetId);
      if (requestId !== this.recordRequestId || this.currentTweetId !== tweetId) return;
      this.applyTweetRecord(record);
    } catch (error) {
      if (requestId !== this.recordRequestId || this.currentTweetId !== tweetId) return;
      this.setSheetStatus(
        'error',
        error instanceof Error ? error.message : '无法获取当前推文数据，请重新加载页面。',
      );
      console.error('分享有据 · Share This Tweet: failed to resolve tweet record', error);
    } finally {
      if (requestId === this.recordRequestId) this.trigger?.removeAttribute('aria-busy');
    }
  }

  private applyTweetRecord(record: TweetRecord): void {
    const firstRecord = !this.currentRecord;
    this.currentRecord = record;
    this.reconcileMediaSelection(record);
    const summary = this.sheet?.querySelector<HTMLElement>('.stt-tweet-summary');
    if (!summary) return;
    const update = (selector: string, value: string): void => {
      const item = summary.querySelector<HTMLElement>(selector);
      if (item) item.textContent = value;
    };
    const handle = record.author.handle
      ? `@${record.author.handle.replace(/^@+/, '')}`
      : '账号未知';
    const name = record.author.name || handle;
    update('[data-stt-author]', name);
    update('[data-stt-handle]', handle);
    update('[data-stt-avatar]', Array.from(name.replace(/^@/, ''))[0] || 'X');
    update('[data-stt-tweet-id]', record.tweetId);
    update('[data-stt-text]', record.text || '这条推文没有正文。');
    const date = record.publishedAt ? new Date(record.publishedAt) : undefined;
    update(
      '[data-stt-date]',
      date && !Number.isNaN(date.getTime())
        ? new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }).format(date)
        : '发布时间暂不可用',
    );
    const link = summary.querySelector<HTMLAnchorElement>('[data-stt-source-link]');
    if (link) {
      link.href = sourceURL(record);
      link.textContent = '查看原推';
    }
    const expander = summary.querySelector<HTMLButtonElement>('[data-stt-expand-text]');
    if (expander)
      expander.hidden =
        (record.text || '').length < 70 && (record.text || '').split('\n').length < 3;
    this.trigger?.removeAttribute('aria-busy');
    this.renderActions(this.currentRecord ?? record);
    if (firstRecord) this.setSheetStatus('ready', '');
  }

  private setSheetStatus(state: 'loading' | 'ready' | 'error', message: string): void {
    if (!this.sheet) return;
    this.sheet.dataset.dataState = state;
    const status = this.sheet.querySelector<HTMLElement>('.stt-sheet-status');
    if (status) {
      status.textContent = message;
      status.hidden = !message;
      if (state === 'error' && !this.currentRecord) {
        const reload = node('button', 'stt-source-link', '重新加载页面');
        reload.type = 'button';
        reload.addEventListener('click', () => location.reload());
        status.append(document.createTextNode(' '), reload);
      }
    }
  }

  private findPrimaryArticle(tweetId: string): HTMLElement | undefined {
    const articles = Array.from(document.querySelectorAll<HTMLElement>('article'));

    return articles.find((article) => {
      if (article.closest('article') !== article) return false;

      return Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href]')).some((anchor) => {
        try {
          const url = new URL(anchor.href, location.href);
          return getTweetIdFromPath(url.pathname) === tweetId;
        } catch {
          return false;
        }
      });
    });
  }

  private mountEntry(article: HTMLElement, tweetId: string): void {
    const target = article.querySelector<HTMLElement>('[role="group"]') ?? article;
    const existingHosts = Array.from(
      article.querySelectorAll<HTMLElement>(`[${ACTION_HOST_ATTRIBUTE}]`),
    );
    const host = existingHosts[0] ?? document.createElement('span');
    for (const duplicate of existingHosts.slice(1)) duplicate.remove();
    host.className = 'stt-action-host';
    host.setAttribute(ACTION_HOST_ATTRIBUTE, '');

    // Reuse a host left by a previous temporary-extension reload. Cloning the
    // button removes stale listeners while keeping the DOM injection idempotent.
    const existingButton = host.querySelector<HTMLButtonElement>('button');
    const button = existingButton
      ? (existingButton.cloneNode(false) as HTMLButtonElement)
      : document.createElement('button');
    button.type = 'button';
    button.className = 'stt-action-button';
    button.setAttribute('aria-label', '保存或复制这条推文，保留来源');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', SHEET_ID);
    button.setAttribute('aria-expanded', 'false');
    button.title = '分享有据 · Share This Tweet';
    button.append(extensionIcon('small'), node('span', '', '分享'));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openSheet();
    });

    host.replaceChildren(button);
    if (!host.isConnected) target.append(host);
    this.actionHost = host;
    this.trigger = button;
    document.getElementById(SHEET_ID)?.remove();
    this.sheet = this.createSheet(tweetId);
    document.body.append(this.sheet);
  }

  private createSheet(tweetId: string): HTMLElement {
    const root = node('div', 'stt-sheet-root');
    root.id = SHEET_ID;
    root.hidden = true;
    const backdrop = node('div', 'stt-sheet-backdrop');
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) this.closeSheet();
    });
    const dialog = node('section', 'stt-sheet');
    dialog.tabIndex = -1;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'stt-sheet-title');
    const header = node('header', 'stt-sheet-header');
    const titleGroup = node('div', 'stt-title-group');
    const brand = node('span', 'stt-brand-mark');
    brand.append(extensionIcon('brand'));
    const headings = node('div', 'stt-headings');
    headings.append(node('p', 'stt-brand-name', '分享有据 · Share This Tweet'));
    const title = node('h2', '', '分享这条推文');
    title.id = 'stt-sheet-title';
    headings.append(title);
    titleGroup.append(brand, headings);
    const close = node('button', 'stt-sheet-close');
    close.type = 'button';
    close.dataset.sttClose = '';
    close.setAttribute('aria-label', '关闭分享面板');
    close.append(icon('close'));
    close.addEventListener('click', () => this.closeSheet());
    header.append(titleGroup, close);
    const scroll = node('div', 'stt-sheet-scroll');
    const summary = node('div', 'stt-tweet-summary');
    const authorRow = node('div', 'stt-author-row');
    const avatar = node('span', 'stt-avatar');
    avatar.dataset.sttAvatar = '';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = 'X';
    const authorNames = node('div', 'stt-author-names');
    const author = node('strong', '', '正在读取推文');
    author.dataset.sttAuthor = '';
    const handle = node('span', 'stt-handle', '');
    handle.dataset.sttHandle = '';
    authorNames.append(author, handle);
    authorRow.append(avatar, authorNames, node('span', 'stt-source-badge', 'X'));
    const text = node('p', 'stt-tweet-text', '内容准备好后，就可以保存或复制。');
    text.dataset.sttText = '';
    text.id = 'stt-summary-text';
    const expander = node('button', 'stt-expand-text', '展开正文');
    expander.type = 'button';
    expander.dataset.sttExpandText = '';
    expander.hidden = true;
    expander.setAttribute('aria-expanded', 'false');
    expander.setAttribute('aria-controls', text.id);
    expander.addEventListener('click', () => {
      const expanded = expander.getAttribute('aria-expanded') !== 'true';
      expander.setAttribute('aria-expanded', String(expanded));
      expander.textContent = expanded ? '收起正文' : '展开正文';
      text.classList.toggle('stt-expanded', expanded);
    });
    const provenance = node('details', 'stt-provenance');
    provenance.append(node('summary', '', '来源信息'));
    const dl = node('dl', '');
    const id = node('dd', '', tweetId);
    id.dataset.sttTweetId = '';
    const date = node('dd', '', '待读取');
    date.dataset.sttDate = '';
    dl.append(node('dt', '', '推文 ID'), id, node('dt', '', '发布时间'), date);
    const sourceLink = node('a', 'stt-source-link', '查看原推');
    sourceLink.dataset.sttSourceLink = '';
    sourceLink.href = `https://x.com/i/status/${encodeURIComponent(tweetId)}`;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    provenance.append(dl, sourceLink);
    summary.append(authorRow, text, expander, provenance);
    const actions = node('div', 'stt-sheet-actions');
    actions.addEventListener('click', (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('button[data-stt-action]')
          : null;
      if (!target || !actions.contains(target) || target.disabled) return;
      event.preventDefault();
      const action = target.dataset.sttAction;
      if (action === 'copy-text') {
        void this.copyText();
        return;
      }
      if (action === 'share-text') {
        void this.shareTweetText();
        return;
      }
      if (action === 'share-image') {
        void this.shareTweetImage();
        return;
      }
      if (action === 'save-card-fallback') {
        void this.saveGeneratedCard();
        return;
      }
      if (action === 'download-selected') {
        const mode = target.dataset.sttBatchMode;
        if (mode === 'original' || mode === 'framed') void this.saveSelectedMedia(mode);
        return;
      }
      const index = Number(target.dataset.sttMediaIndex);
      if (!Number.isInteger(index)) return;
      if (action === 'select-media') {
        this.toggleMediaSelection(index);
      } else if (action === 'download-media') void this.saveMedia(index);
      else if (action === 'frame-media') {
        const orientation = target.dataset.sttOrientation;
        if (orientation === 'top' || orientation === 'bottom') {
          if (target.dataset.sttBatchMode === 'framed')
            void this.saveSelectedMedia('framed', orientation);
          else void this.generateFrame(index, orientation);
        }
      }
    });
    const skeleton = node('div', 'stt-action-skeleton', '正在准备分享选项…');
    skeleton.setAttribute('aria-hidden', 'true');
    actions.append(skeleton);
    scroll.append(summary, actions);
    const status = node('p', 'stt-sheet-status', '正在读取推文…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const footer = node('footer', 'stt-sheet-footer');
    footer.append(status, node('p', 'stt-sheet-note', '分享喜欢，也留下出处。'));
    dialog.append(header, scroll, footer);
    backdrop.append(dialog);
    root.append(backdrop);
    return root;
  }

  private renderActions(record: TweetRecord): void {
    const actions = this.sheet?.querySelector<HTMLElement>('.stt-sheet-actions');
    if (!actions) return;
    this.reconcileMediaSelection(record);
    const active =
      document.activeElement instanceof HTMLElement && actions.contains(document.activeElement)
        ? document.activeElement
        : undefined;
    const focusKey = active?.dataset.sttFocusKey;
    const filenameOpen =
      actions.querySelector<HTMLDetailsElement>('.stt-file-details')?.open ?? false;
    const scroll = this.sheet?.querySelector<HTMLElement>('.stt-sheet-scroll');
    const scrollTop = scroll?.scrollTop ?? 0;
    const stripScroll = actions.querySelector<HTMLElement>('.stt-media-strip')?.scrollLeft ?? 0;
    actions.replaceChildren();
    if (record.media.length > 0) {
      const selectionHeading = node('div', 'stt-section-label');
      const position =
        this.selectedMediaIndex === undefined
          ? 0
          : record.media.findIndex((media) => media.index === this.selectedMediaIndex) + 1;
      selectionHeading.append(
        node('span', '', record.media.length > 1 ? '选择要保存的媒体' : '这条推文的内容'),
        node(
          'span',
          'stt-selection-count',
          record.media.length > 1
            ? `已选 ${this.selectedMediaIndexes.size} / ${record.media.length}`
            : `${position} / ${record.media.length}`,
        ),
      );
      actions.append(selectionHeading);
      const strip = node('div', 'stt-media-strip');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', '选择媒体');
      record.media.forEach((media) => {
        const selected = this.selectedMediaIndexes.has(media.index);
        const choice = node('button', 'stt-media-choice');
        choice.type = 'button';
        choice.dataset.sttAction = 'select-media';
        choice.dataset.sttMediaIndex = String(media.index);
        choice.dataset.sttFocusKey = `select-${media.index}`;
        choice.disabled = this.batchDownloadMode !== undefined;
        choice.setAttribute('aria-pressed', String(selected));
        const label =
          media.type === 'photo' ? '照片' : media.type === 'animated_gif' ? 'GIF' : '视频';
        choice.setAttribute('aria-label', `${label} ${media.index}${selected ? '，已选中' : ''}`);
        const thumb = node('span', 'stt-media-thumb');
        thumb.append(icon(media.type === 'photo' ? 'photo' : 'video'));
        const url = thumbnailURL(media);
        if (url) {
          const img = node('img', '');
          img.src = url;
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', () => img.remove(), { once: true });
          thumb.append(img);
        }
        const check = node('span', 'stt-thumb-check');
        check.append(icon('check'));
        thumb.append(check);
        choice.append(thumb, node('span', 'stt-media-label', `${label} ${media.index}`));
        strip.append(choice);
      });
      actions.append(strip);
      const selected =
        record.media.find((media) => media.index === this.selectedMediaIndex) ?? record.media[0];
      if (selected) actions.append(this.createMediaAction(record, selected));
    }
    if (isAndroidUserAgent(navigator.userAgent)) actions.append(this.createShareActions(record));
    else {
      actions.append(this.createCardSaveButton('保存正文、作者与来源为 PNG'));
      if (this.cardSaveState === 'error')
        actions.append(this.errorDetails('卡片保存失败，请重试。', this.cardSaveError));
    }
    if (record.media.some((media) => media.type !== 'photo')) {
      actions.append(
        node('p', 'stt-sheet-note', '推文卡片不包含视频或 GIF，仅保留正文、照片和来源。'),
      );
    }
    actions.append(this.createTextAction(record.media.length === 0));
    const details = actions.querySelector<HTMLDetailsElement>('.stt-file-details');
    if (details) details.open = filenameOpen;
    const newStrip = actions.querySelector<HTMLElement>('.stt-media-strip');
    if (newStrip) newStrip.scrollLeft = stripScroll;
    if (scroll) scroll.scrollTop = scrollTop;
    if (focusKey) {
      const target = Array.from(actions.querySelectorAll<HTMLElement>('[data-stt-focus-key]')).find(
        (item) => item.dataset.sttFocusKey === focusKey,
      );
      if (target instanceof HTMLButtonElement && !target.disabled)
        target.focus({ preventScroll: true });
      else if (target) {
        // While an action is disabled, keep keyboard focus inside the dialog.
        if (target.parentElement) {
          target.parentElement.dataset.sttFocusKey = focusKey;
          target.parentElement.setAttribute('tabindex', '-1');
          target.parentElement.focus({ preventScroll: true });
        }
      }
    }
  }

  private actionButton(
    action: string,
    focusKey: string,
    label: string,
    description: string,
    image: IconName,
    state: MediaActionState,
    primary = false,
  ): HTMLButtonElement {
    const button = node('button', `stt-command${primary ? ' stt-command-primary' : ''}`);
    button.type = 'button';
    button.dataset.sttAction = action;
    button.dataset.sttFocusKey = focusKey;
    button.dataset.state = state;
    button.disabled = state === 'loading';
    button.setAttribute('aria-busy', String(state === 'loading'));
    const glyph = node('span', 'stt-command-icon');
    glyph.append(icon(state === 'success' ? 'check' : image));
    const copy = node('span', 'stt-command-copy');
    copy.append(node('strong', '', label));
    if (description) copy.append(node('span', '', description));
    const end = node('span', 'stt-command-end');
    end.append(icon(state === 'loading' ? 'download' : 'arrow'));
    button.append(glyph, copy, end);
    return button;
  }

  private createTextAction(primary = false): HTMLElement {
    const wrapper = node('div', 'stt-text-action');
    wrapper.dataset.state = this.textActionState;
    const state = this.textActionState;
    const label =
      state === 'loading'
        ? '正在复制…'
        : state === 'success'
          ? '已复制 · 再复制一次'
          : state === 'error'
            ? '重试复制文字'
            : '复制推文文字';
    wrapper.append(
      this.actionButton(
        'copy-text',
        'copy-text',
        label,
        '复制后，直接粘贴到聊天中',
        'copy',
        state,
        primary,
      ),
    );
    if (state === 'error')
      wrapper.append(this.errorDetails('没能复制，请重试或检查剪贴板权限。', this.textActionError));
    return wrapper;
  }

  private errorDetails(message: string, technical: string): HTMLElement {
    const wrapper = node('div', 'stt-inline-error');
    wrapper.setAttribute('role', 'status');
    wrapper.append(node('p', '', message));
    if (technical) {
      const details = node('details', '');
      details.append(node('summary', '', '查看详细信息'), node('p', '', technical));
      wrapper.append(details);
    }
    return wrapper;
  }

  private reconcileMediaSelection(record: TweetRecord): void {
    const available = new Set(record.media.map((media) => media.index));
    for (const index of this.selectedMediaIndexes) {
      if (!available.has(index)) this.selectedMediaIndexes.delete(index);
    }
    if (this.selectedMediaIndex !== undefined && !available.has(this.selectedMediaIndex)) {
      this.selectedMediaIndex = undefined;
    }
    if (this.selectedMediaIndex === undefined && this.selectedMediaIndexes.size > 0) {
      this.selectedMediaIndex = this.selectedMediaIndexes.values().next().value;
    }
    if (!this.mediaSelectionInitialized && record.media.length > 0) {
      this.mediaSelectionInitialized = true;
      this.selectedMediaIndex = this.selectedMediaIndex ?? record.media[0]?.index;
      if (this.selectedMediaIndex !== undefined)
        this.selectedMediaIndexes.add(this.selectedMediaIndex);
    }
  }

  private toggleMediaSelection(mediaIndex: number): void {
    const record = this.currentRecord;
    if (
      this.batchDownloadMode !== undefined ||
      !record ||
      !record.media.some((media) => media.index === mediaIndex)
    )
      return;
    if (this.selectedMediaIndexes.has(mediaIndex)) {
      if (this.selectedMediaIndexes.size > 1) {
        this.selectedMediaIndexes.delete(mediaIndex);
        this.selectedMediaIndex = this.selectedMediaIndexes.values().next().value;
      } else {
        this.selectedMediaIndexes.delete(mediaIndex);
        this.selectedMediaIndex = undefined;
      }
    } else {
      this.selectedMediaIndexes.add(mediaIndex);
      this.selectedMediaIndex = mediaIndex;
    }
    this.resetBatchDownloadStates();
    this.renderActions(record);
  }

  private isBatchDownloading(): boolean {
    return this.batchDownloadMode !== undefined;
  }

  private resetBatchDownloadStates(): void {
    this.batchDownloadMode = undefined;
    this.batchOriginalState = 'idle';
    this.batchOriginalError = '';
    this.batchFrameStates.top = 'idle';
    this.batchFrameStates.bottom = 'idle';
    this.batchFrameErrors.top = '';
    this.batchFrameErrors.bottom = '';
  }

  private createShareActions(record: TweetRecord): HTMLElement {
    const wrapper = node('div', 'stt-share-actions');
    const textButton = this.actionButton(
      'share-text',
      'share-text',
      this.textShareState === 'loading'
        ? '正在分享文本…'
        : this.textShareState === 'success'
          ? '再次分享文本'
          : this.textShareState === 'error'
            ? '重试分享文本'
            : '分享文本',
      '',
      'share',
      this.textShareState,
      false,
    );
    const imageButton = this.actionButton(
      'share-image',
      'share-image',
      this.imageShareState === 'loading'
        ? '正在分享推文卡片…'
        : this.imageShareState === 'success'
          ? '再次分享推文卡片'
          : this.imageShareState === 'error'
            ? '重试分享推文卡片'
            : '分享推文卡片',
      '',
      'share',
      this.imageShareState,
      false,
    );
    const imageShareSupported = this.canShareImageFile();
    wrapper.append(textButton);
    if (imageShareSupported) wrapper.append(imageButton);
    else wrapper.append(this.createCardSaveButton('当前环境不支持图片文件分享'));
    if (this.textShareState === 'error') {
      wrapper.append(
        this.errorDetails('文本分享失败，请重试或改用复制文本。', this.textShareError),
      );
    }
    if (this.imageShareState === 'error') {
      wrapper.append(this.errorDetails('推文卡片分享失败，请重试。', this.imageShareError));
      if (this.generatedCardFile) {
        wrapper.append(this.createCardSaveButton('卡片已经生成，只是原生分享没有成功'));
      }
    }
    if (this.cardSaveState === 'error') {
      wrapper.append(this.errorDetails('卡片保存失败，请重试。', this.cardSaveError));
    }
    return wrapper;
  }

  private canShareImageFile(): boolean {
    try {
      return canShareFile(
        new File(['share-this-tweet'], 'share-this-tweet-card.png', { type: 'image/png' }),
      );
    } catch {
      return false;
    }
  }

  private createCardSaveButton(description: string): HTMLButtonElement {
    const button = this.actionButton(
      'save-card-fallback',
      'save-card-fallback',
      this.cardSaveState === 'loading'
        ? '正在保存推文卡片…'
        : this.cardSaveState === 'success'
          ? '再次保存推文卡片'
          : '保存推文卡片',
      description,
      'download',
      this.cardSaveState,
      false,
    );
    button.classList.add('stt-share-fallback');
    return button;
  }

  private async createCardFile(record: TweetRecord, photos: MediaRecord[]): Promise<File> {
    const result = await renderTweetCard(record, photos);
    const filename = buildCardFilename(record, photos[0], this.settings.filenameTemplate);
    return new File([result.blob], filename, { type: 'image/png' });
  }

  private async shareTweetText(): Promise<void> {
    const record = this.currentRecord;
    if (!record || this.textShareState === 'loading') return;
    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    this.textShareState = 'loading';
    this.textShareError = '';
    this.renderActions(record);
    this.setSheetStatus('loading', '正在打开文本分享…');
    try {
      await shareText(buildTweetText(record, this.settings.textTemplate));
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      const storageWarning = await this.persistOutput(record, {
        tweetId,
        outputType: 'shared-text',
      });
      this.textShareState = 'success';
      this.renderActions(record);
      this.setSheetStatus(storageWarning ? 'error' : 'ready', storageWarning ?? '文本分享已完成。');
    } catch (error) {
      if (error instanceof ShareCancelledError) {
        this.textShareState = 'idle';
        this.renderActions(record);
        this.setSheetStatus('ready', '已取消文本分享。');
        return;
      }
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      this.textShareState = 'error';
      this.textShareError = error instanceof Error ? error.message : String(error);
      this.renderActions(record);
      this.setSheetStatus('error', '');
    }
  }

  private async shareTweetImage(): Promise<void> {
    const record = this.currentRecord;
    const photos = record?.media.filter((media) => media.type === 'photo') ?? [];
    if (!record || this.imageShareState === 'loading') return;
    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    const isCurrent = (): boolean =>
      epoch === this.recordRequestId && this.currentTweetId === tweetId;
    this.imageShareState = 'loading';
    this.imageShareError = '';
    this.renderActions(record);
    this.setSheetStatus('loading', '正在生成并打开推文卡片分享…');
    try {
      const cardFile = this.generatedCardFile ?? (await this.createCardFile(record, photos));
      if (!isCurrent()) return;
      this.generatedCardFile = cardFile;
      await shareImage(cardFile);
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      const storageWarning = await this.persistOutput(record, {
        tweetId,
        outputType: 'shared-image',
        filename: cardFile.name,
        ...(photos[0] ? { mediaIndex: photos[0].index } : {}),
      });
      if (!isCurrent()) return;
      this.imageShareState = 'success';
      this.renderActions(record);
      this.setSheetStatus(
        storageWarning ? 'error' : 'ready',
        storageWarning ?? '推文卡片分享已完成。',
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ShareCancelledError) {
        this.imageShareState = 'idle';
        this.renderActions(record);
        this.setSheetStatus('ready', '已取消图片分享。');
        return;
      }
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      this.imageShareState = 'error';
      this.imageShareError = error instanceof Error ? error.message : String(error);
      if (error instanceof ShareFailedError && error.file) this.generatedCardFile = error.file;
      this.renderActions(record);
      this.setSheetStatus('error', '');
    }
  }

  private async saveGeneratedCard(): Promise<void> {
    const record = this.currentRecord;
    const file = this.generatedCardFile;
    const photo = record?.media.find((media) => media.type === 'photo');
    if (!record || this.cardSaveState === 'loading') return;
    const epoch = this.recordRequestId;
    const isCurrent = (): boolean =>
      epoch === this.recordRequestId && this.currentTweetId === record.tweetId;
    this.cardSaveState = 'loading';
    this.cardSaveError = '';
    this.renderActions(record);
    try {
      const cardFile =
        file ??
        (await this.createCardFile(
          record,
          record.media.filter((media) => media.type === 'photo'),
        ));
      if (!isCurrent()) return;
      this.generatedCardFile = cardFile;
      downloadBlob(cardFile, cardFile.name);
      const storageWarning = await this.persistOutput(record, {
        tweetId: record.tweetId,
        outputType: 'tweet-card',
        filename: cardFile.name,
        ...(photo ? { mediaIndex: photo.index } : {}),
      });
      if (!isCurrent()) return;
      this.cardSaveState = 'success';
      this.renderActions(record);
      this.setSheetStatus(storageWarning ? 'error' : 'ready', storageWarning ?? '推文卡片已保存。');
    } catch (error) {
      if (!isCurrent()) return;
      this.cardSaveState = 'error';
      this.cardSaveError = error instanceof Error ? error.message : String(error);
      this.renderActions(record);
      this.setSheetStatus('error', '推文卡片保存失败，请查看详情后重试。');
    }
  }

  private async copyText(): Promise<void> {
    const record = this.currentRecord;
    if (!record || this.textActionState === 'loading') return;

    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    this.textActionState = 'loading';
    this.textActionError = '';
    this.renderActions(this.currentRecord ?? record);
    this.setSheetStatus('loading', '正在复制推文文本…');

    try {
      await copyTweetText(record, this.settings.textTemplate);
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      const storageWarning = await this.persistOutput(record, {
        tweetId: record.tweetId,
        outputType: 'copied-text',
      });
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      this.textActionState = 'success';
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus(
        storageWarning ? 'error' : 'ready',
        storageWarning ?? '已复制，可直接粘贴到聊天中。',
      );
    } catch (error) {
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      this.textActionState = 'error';
      this.textActionError = error instanceof Error ? error.message : String(error);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能复制，请查看详情后重试。');
      console.error('分享有据 · Share This Tweet: failed to copy tweet text', error);
    }
  }

  private async persistOutput(
    record: TweetRecord,
    output: OutputRecordInput,
  ): Promise<string | undefined> {
    try {
      await saveTweetRecord(record);
      await recordOutput(output);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('分享有据 · Share This Tweet: failed to persist source record', error);
      return `当前操作已完成，但来源记录保存失败：${message}`;
    }
  }

  private createMediaAction(record: TweetRecord, media: MediaRecord): HTMLElement {
    const wrapper = node('div', 'stt-media-action');
    const noSelection = this.selectedMediaIndexes.size === 0;
    const singleState = noSelection ? 'idle' : (this.mediaActionStates.get(media.index) ?? 'idle');
    const batch = this.selectedMediaIndexes.size > 1;
    const selectedPhotos = record.media.filter(
      (candidate) => this.selectedMediaIndexes.has(candidate.index) && candidate.type === 'photo',
    );
    const showFrameActions =
      noSelection || media.type === 'photo' || (batch && selectedPhotos.length > 0);
    wrapper.dataset.state = singleState;
    const photo = media.type === 'photo';
    if (showFrameActions) {
      const frameActions = node('div', 'stt-frame-direction-grid');
      for (const orientation of FRAME_ORIENTATIONS) {
        const state = noSelection
          ? 'idle'
          : batch
            ? this.batchFrameStates[orientation]
            : (this.frameActionStates.get(this.frameActionKey(media.index, orientation)) ?? 'idle');
        const preferred = orientation === this.settings.frameOrientation;
        const direction = FRAME_ORIENTATION_LABELS[orientation];
        const label = batch
          ? state === 'loading'
            ? '正在保存已选媒体…'
            : state === 'success'
              ? `再次保存已选媒体（带${direction}画框）`
              : state === 'error'
                ? `重试保存已选媒体（带${direction}画框）`
                : `保存已选媒体（带${direction}画框）`
          : state === 'loading'
            ? `正在制作${direction}画框…`
            : state === 'success'
              ? `再保存一张${direction}画框`
              : state === 'error'
                ? `重试${direction}画框`
                : `保存${direction}画框`;
        const frame = this.actionButton(
          'frame-media',
          `frame-${media.index}-${orientation}`,
          label,
          batch
            ? '照片添加画框，视频和 GIF 原样保存'
            : preferred
              ? '默认方向 · 一键保存'
              : '本次直接覆盖默认方向',
          'frame',
          state,
          preferred,
        );
        frame.classList.add('stt-media-frame-button');
        frame.dataset.sttMediaIndex = String(media.index);
        frame.dataset.sttOrientation = orientation;
        if (batch) frame.dataset.sttBatchMode = 'framed';
        frame.disabled = frame.disabled || this.isBatchDownloading() || noSelection;
        frameActions.append(frame);
      }
      wrapper.append(frameActions);
      const frameError = noSelection
        ? undefined
        : batch
          ? FRAME_ORIENTATIONS.map((orientation) => this.batchFrameErrors[orientation]).find(
              (message) => message,
            )
          : FRAME_ORIENTATIONS.map((orientation) =>
              this.frameActionErrors.get(this.frameActionKey(media.index, orientation)),
            ).find((message) => message);
      if (frameError)
        wrapper.append(
          this.errorDetails(
            batch ? '部分带画框媒体保存失败，请重试。' : '这次画框没能生成，请重试。',
            frameError,
          ),
        );
    }
    const state = batch ? this.batchOriginalState : singleState;
    const mediaLabel = photo ? '原图' : media.type === 'animated_gif' ? 'GIF 视频' : '视频';
    const label = batch
      ? state === 'loading'
        ? '正在保存已选媒体…'
        : state === 'success'
          ? `再次保存已选媒体（${this.selectedMediaIndexes.size}）`
          : state === 'error'
            ? '重试保存已选媒体'
            : `保存已选媒体（${this.selectedMediaIndexes.size}）`
      : state === 'loading'
        ? '正在保存…'
        : state === 'success'
          ? `再次保存${mediaLabel}`
          : state === 'error'
            ? `重试保存${mediaLabel}`
            : `保存${mediaLabel}`;
    const button = this.actionButton(
      batch ? 'download-selected' : 'download-media',
      batch ? 'download-selected-original' : `download-${media.index}`,
      label,
      batch
        ? '照片、视频和 GIF 均按原始媒体保存'
        : photo
          ? '不加画框，保留原始图片'
          : media.type === 'animated_gif'
            ? '以 MP4 格式保存，不转换成 .gif'
            : '以 MP4 格式保存',
      'download',
      state,
      batch || !photo,
    );
    button.disabled = button.disabled || this.isBatchDownloading() || noSelection;
    if (batch) button.dataset.sttBatchMode = 'original';
    else button.dataset.sttMediaIndex = String(media.index);
    let filename = '';
    if (!noSelection) {
      try {
        filename = buildMediaFilename(record, media, this.settings.filenameTemplate);
      } catch (error) {
        button.disabled = true;
        wrapper.append(
          this.errorDetails(
            '请先检查设置中的文件名模板。',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    wrapper.append(button);
    if (state === 'error') {
      wrapper.append(
        this.errorDetails(
          batch ? '部分原始媒体保存失败，请重试。' : '没能保存，请检查网络后重试。',
          batch ? this.batchOriginalError : (this.mediaActionErrors.get(media.index) ?? ''),
        ),
      );
    }
    if (filename) {
      const details = node('details', 'stt-file-details');
      details.append(node('summary', '', '查看保存文件名'));
      const list = node('dl', '');
      list.append(node('dt', '', photo ? '原图' : '视频'), node('dd', '', filename));
      if (photo) {
        try {
          list.append(
            node('dt', '', '画框'),
            node('dd', '', buildFrameFilename(record, media, this.settings.filenameTemplate)),
          );
        } catch {
          list.append(node('dt', '', '画框'), node('dd', '', '文件名暂不可用，请检查模板。'));
        }
      }
      details.append(list);
      wrapper.append(details);
    }
    return wrapper;
  }

  private async saveMedia(mediaIndex: number): Promise<void> {
    const record = this.currentRecord;
    const media = record?.media.find((candidate) => candidate.index === mediaIndex);
    if (!record || !media) return;
    const state = this.mediaActionStates.get(mediaIndex) ?? 'idle';
    if (state === 'loading') return;

    let filename: string;
    try {
      filename = buildMediaFilename(record, media, this.settings.filenameTemplate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.mediaActionStates.set(mediaIndex, 'error');
      this.mediaActionErrors.set(mediaIndex, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能保存，请在下方查看详情后重试。');
      return;
    }

    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    this.mediaActionStates.set(mediaIndex, 'loading');
    this.mediaActionErrors.delete(mediaIndex);
    this.renderActions(this.currentRecord ?? record);
    this.setSheetStatus('loading', `正在保存第 ${media.index} 项媒体…`);

    try {
      await downloadMediaFile(media, filename);
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      const storageWarning = await this.persistOutput(record, {
        tweetId: record.tweetId,
        outputType: 'original-media',
        filename,
        mediaIndex: media.index,
      });
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      this.mediaActionStates.set(mediaIndex, 'success');
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus(
        storageWarning ? 'error' : 'ready',
        storageWarning ?? '已交给浏览器保存，可在下载列表中查看。',
      );
    } catch (error) {
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      const message = error instanceof Error ? error.message : String(error);
      this.mediaActionStates.set(mediaIndex, 'error');
      this.mediaActionErrors.set(mediaIndex, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能保存，请在下方查看详情后重试。');
      console.error('分享有据 · Share This Tweet: failed to download media', error);
    }
  }

  private async saveSelectedMedia(
    mode: BatchDownloadMode,
    orientation?: FrameOrientation,
  ): Promise<void> {
    const record = this.currentRecord;
    const selected =
      record?.media.filter((media) => this.selectedMediaIndexes.has(media.index)) ?? [];
    if (mode === 'framed' && !orientation) return;
    const frameOrientation = orientation ?? this.settings.frameOrientation;
    const state =
      mode === 'original' ? this.batchOriginalState : this.batchFrameStates[frameOrientation];
    if (
      !record ||
      selected.length < 2 ||
      this.batchDownloadMode !== undefined ||
      state === 'loading'
    )
      return;

    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    const failures: string[] = [];
    const storageWarnings: string[] = [];
    this.batchDownloadMode = mode;
    if (mode === 'original') {
      this.batchOriginalState = 'loading';
      this.batchOriginalError = '';
    } else {
      this.batchFrameStates[frameOrientation] = 'loading';
      this.batchFrameErrors[frameOrientation] = '';
    }
    this.renderActions(record);

    for (const [index, media] of selected.entries()) {
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      try {
        if (mode === 'framed' && media.type === 'photo') {
          const filename = buildFrameFilename(record, media, this.settings.filenameTemplate);
          const blob = await renderPhotoFrame(
            record,
            media,
            this.settings.frameTemplate,
            frameOrientation,
          );
          downloadBlob(blob, filename);
          const storageWarning = await this.persistOutput(record, {
            tweetId: record.tweetId,
            outputType: 'framed-image',
            filename,
            mediaIndex: media.index,
          });
          if (storageWarning) storageWarnings.push(`第 ${media.index} 项：${storageWarning}`);
          const actionKey = this.frameActionKey(media.index, frameOrientation);
          this.frameActionStates.set(actionKey, 'success');
          this.frameActionErrors.delete(actionKey);
        } else {
          const filename = buildMediaFilename(record, media, this.settings.filenameTemplate);
          await downloadMediaFile(media, filename);
          const storageWarning = await this.persistOutput(record, {
            tweetId: record.tweetId,
            outputType: 'original-media',
            filename,
            mediaIndex: media.index,
          });
          if (storageWarning) storageWarnings.push(`第 ${media.index} 项：${storageWarning}`);
          this.mediaActionStates.set(media.index, 'success');
          this.mediaActionErrors.delete(media.index);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`第 ${media.index} 项：${message}`);
        if (mode === 'framed' && media.type === 'photo') {
          const actionKey = this.frameActionKey(media.index, frameOrientation);
          this.frameActionStates.set(actionKey, 'error');
          this.frameActionErrors.set(actionKey, message);
        } else {
          this.mediaActionStates.set(media.index, 'error');
          this.mediaActionErrors.set(media.index, message);
        }
      }
      this.renderActions(record);
      this.setSheetStatus(
        'loading',
        `正在保存${mode === 'framed' ? '带画框的' : ''}已选媒体（${index + 1}/${selected.length}）…`,
      );
    }

    if (
      epoch !== this.recordRequestId ||
      this.currentTweetId !== tweetId ||
      this.currentRecord?.tweetId !== tweetId
    )
      return;
    this.batchDownloadMode = undefined;
    if (failures.length > 0) {
      if (mode === 'original') {
        this.batchOriginalState = 'error';
        this.batchOriginalError = failures.join('；');
      } else {
        this.batchFrameStates[frameOrientation] = 'error';
        this.batchFrameErrors[frameOrientation] = failures.join('；');
      }
      this.renderActions(record);
      this.setSheetStatus('error', `${failures.length} 项媒体保存失败，请查看详情后重试。`);
      console.error(
        `分享有据 · Share This Tweet: failed to download selected ${mode} media`,
        failures,
      );
      return;
    }

    if (mode === 'original') this.batchOriginalState = 'success';
    else this.batchFrameStates[frameOrientation] = 'success';
    this.renderActions(record);
    const successMessage =
      mode === 'framed'
        ? `已交给浏览器保存，共 ${selected.length} 项媒体；照片带${FRAME_ORIENTATION_LABELS[frameOrientation]}画框，视频和 GIF 原样保存。`
        : `已交给浏览器保存，共 ${selected.length} 项原始媒体。`;
    this.setSheetStatus(
      storageWarnings.length > 0 ? 'error' : 'ready',
      storageWarnings.length > 0
        ? `${successMessage}但部分来源记录保存失败：${storageWarnings.join('；')}`
        : successMessage,
    );
  }

  private frameActionKey(mediaIndex: number, orientation: FrameOrientation): string {
    return `${mediaIndex}:${orientation}`;
  }

  private async generateFrame(
    mediaIndex: number,
    orientation = this.settings.frameOrientation,
  ): Promise<void> {
    const record = this.currentRecord;
    const media = record?.media.find((candidate) => candidate.index === mediaIndex);
    if (!record || !media || media.type !== 'photo') return;
    const actionKey = this.frameActionKey(mediaIndex, orientation);
    const state = this.frameActionStates.get(actionKey) ?? 'idle';
    if (state === 'loading') return;

    let filename: string;
    try {
      filename = buildFrameFilename(record, media, this.settings.filenameTemplate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.frameActionStates.set(actionKey, 'error');
      this.frameActionErrors.set(actionKey, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能生成画框，请查看详情后重试。');
      return;
    }

    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    this.frameActionStates.set(actionKey, 'loading');
    this.frameActionErrors.delete(actionKey);
    this.renderActions(this.currentRecord ?? record);
    this.setSheetStatus('loading', `正在生成第 ${media.index} 项画框…`);

    try {
      const blob = await renderPhotoFrame(record, media, this.settings.frameTemplate, orientation);
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      downloadBlob(blob, filename);
      const storageWarning = await this.persistOutput(record, {
        tweetId: record.tweetId,
        outputType: 'framed-image',
        filename,
        mediaIndex: media.index,
      });
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      this.frameActionStates.set(actionKey, 'success');
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus(
        storageWarning ? 'error' : 'ready',
        storageWarning ?? '带来源的图片已生成，并交给浏览器保存。',
      );
    } catch (error) {
      if (
        epoch !== this.recordRequestId ||
        this.currentTweetId !== tweetId ||
        this.currentRecord?.tweetId !== tweetId
      )
        return;
      const message = error instanceof Error ? error.message : String(error);
      this.frameActionStates.set(actionKey, 'error');
      this.frameActionErrors.set(actionKey, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能生成画框，请查看详情后重试。');
      console.error('分享有据 · Share This Tweet: failed to render photo frame', error);
    }
  }

  private lockPage(): void {
    if (this.restoreOverlay || !this.sheet) return;
    const siblings = Array.from(document.body.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== this.sheet,
    );
    const inertState = siblings.map((element) => ({ element, inert: element.inert }));
    for (const { element } of inertState) element.inert = true;
    const targets = [document.documentElement, document.body];
    const overflow = targets.map((element) => ({
      element,
      value: element.style.getPropertyValue('overflow'),
      priority: element.style.getPropertyPriority('overflow'),
    }));
    for (const { element } of overflow)
      element.style.setProperty('overflow', 'hidden', 'important');
    this.restoreOverlay = () => {
      for (const { element, inert } of inertState) element.inert = inert;
      for (const { element, value, priority } of overflow) {
        if (value) element.style.setProperty('overflow', value, priority);
        else element.style.removeProperty('overflow');
      }
    };
  }

  private openSheet(): void {
    if (!this.sheet) return;
    if (!this.sheet.hidden && this.sheet.dataset.state !== 'closing') return;
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.sheet.hidden = false;
    delete this.sheet.dataset.state;
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.lockPage();
    requestAnimationFrame(() => {
      if (this.sheet && !this.sheet.hidden && this.sheet.dataset.state !== 'closing')
        this.sheet.dataset.state = 'open';
    });
    this.sheet.querySelector<HTMLButtonElement>('[data-stt-close]')?.focus({ preventScroll: true });
    // Refresh saved preferences when reopening; never cache old settings for the
    // entire lifetime of an X tab.
    void this.loadSettings();
  }

  private closeSheet(immediate = false): void {
    if (!this.sheet) return;
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.sheet.dataset.state = 'closing';
    this.trigger?.setAttribute('aria-expanded', 'false');
    this.restoreOverlay?.();
    this.restoreOverlay = undefined;
    if (immediate) {
      this.sheet.hidden = true;
      delete this.sheet.dataset.state;
    } else if (!this.sheet.hidden) {
      this.closeTimer = window.setTimeout(() => {
        if (!this.sheet) return;
        this.sheet.hidden = true;
        delete this.sheet.dataset.state;
        this.closeTimer = undefined;
      }, 180);
    }
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = undefined;
  }

  private removeEntry(): void {
    this.closeSheet(true);
    this.sheet?.remove();
    this.actionHost?.remove();
    this.sheet = undefined;
    this.actionHost = undefined;
    this.trigger = undefined;
    this.currentRecord = undefined;
    this.selectedMediaIndex = undefined;
    this.selectedMediaIndexes.clear();
    this.mediaSelectionInitialized = false;
    this.resetBatchDownloadStates();
    this.recordRequestId += 1;
    this.mediaActionStates.clear();
    this.mediaActionErrors.clear();
    this.frameActionStates.clear();
    this.frameActionErrors.clear();
    this.textActionState = 'idle';
    this.textActionError = '';
    this.textShareState = 'idle';
    this.textShareError = '';
    this.imageShareState = 'idle';
    this.imageShareError = '';
    this.generatedCardFile = undefined;
    this.cardSaveState = 'idle';
    this.cardSaveError = '';
    this.currentTweetId = undefined;
    this.currentArticle = undefined;
  }
}
