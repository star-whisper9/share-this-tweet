import { getTweetIdFromPath } from '../shared/model.js';
import type { TweetRecord } from '../shared/model.js';
import { TweetSource } from './tweet-source.js';

const ROUTE_CHANGE_EVENT = 'share-this-tweet:route-change';
const ACTION_HOST_ATTRIBUTE = 'data-stt-action-host';
const SHEET_ID = 'stt-bottom-sheet';

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
  private unsubscribeTweetSource?: () => void;

  constructor(private readonly tweetSource: TweetSource) {}

  private readonly onRouteChange = (): void => {
    this.scheduleSync();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.sheet && !this.sheet.hidden) {
      this.closeSheet();
    }
  };

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
      subtree: true
    });
    document.addEventListener('keydown', this.onKeyDown);
    this.sync();
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
    document.removeEventListener('keydown', this.onKeyDown);
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
      this.setSheetStatus('error', '无法获取当前推文数据，请刷新页面后重试。');
      console.error('Share This Tweet: failed to resolve tweet record', error);
    } finally {
      if (requestId === this.recordRequestId) this.trigger?.removeAttribute('aria-busy');
    }
  }

  private applyTweetRecord(record: TweetRecord): void {
    const summary = this.sheet?.querySelector<HTMLElement>('.stt-tweet-summary');
    if (!summary) return;
    const author = summary.querySelector<HTMLElement>('[data-stt-author]');
    const id = summary.querySelector<HTMLElement>('[data-stt-tweet-id]');
    const text = summary.querySelector<HTMLElement>('[data-stt-text]');
    if (author) author.textContent = record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : '@未知作者';
    if (id) id.textContent = `Tweet ID: ${record.tweetId}`;
    if (text) text.textContent = record.text || '（无正文）';
    this.setSheetStatus('ready', '已获取当前推文数据；具体操作将在后续阶段接入。');
  }

  private setSheetStatus(state: 'loading' | 'ready' | 'error', message: string): void {
    if (!this.sheet) return;
    this.sheet.dataset.dataState = state;
    const status = this.sheet.querySelector<HTMLElement>('.stt-sheet-status');
    if (status) status.textContent = message;
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
    const existingHosts = Array.from(article.querySelectorAll<HTMLElement>(`[${ACTION_HOST_ATTRIBUTE}]`));
    const host = existingHosts[0] ?? document.createElement('span');
    for (const duplicate of existingHosts.slice(1)) duplicate.remove();
    host.className = 'stt-action-host';
    host.setAttribute(ACTION_HOST_ATTRIBUTE, '');

    // Reuse a host left by a previous temporary-extension reload. Cloning the
    // button removes stale listeners while keeping the DOM injection idempotent.
    const existingButton = host.querySelector<HTMLButtonElement>('button');
    const button = existingButton
      ? existingButton.cloneNode(false) as HTMLButtonElement
      : document.createElement('button');
    button.type = 'button';
    button.className = 'stt-action-button';
    button.setAttribute('aria-label', '打开分享增强操作');
    button.title = '分享增强';
    button.textContent = '分享';
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
    const root = document.createElement('div');
    root.id = SHEET_ID;
    root.className = 'stt-sheet-root';
    root.hidden = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'stt-sheet-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) this.closeSheet();
    });

    const dialog = document.createElement('section');
    dialog.className = 'stt-sheet';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'stt-sheet-title');

    const header = document.createElement('header');
    header.className = 'stt-sheet-header';

    const title = document.createElement('h2');
    title.id = 'stt-sheet-title';
    title.textContent = '分享增强';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stt-sheet-close';
    close.setAttribute('data-stt-close', '');
    close.setAttribute('aria-label', '关闭');
    close.append(this.createCloseIcon());
    close.addEventListener('click', () => this.closeSheet());

    header.append(title, close);

    const summary = document.createElement('div');
    summary.className = 'stt-tweet-summary';
    const summaryTitle = document.createElement('strong');
    summaryTitle.textContent = '当前推文';
    const summaryId = document.createElement('span');
    summaryId.dataset.sttTweetId = '';
    summaryId.textContent = `Tweet ID: ${tweetId}`;
    const summaryAuthor = document.createElement('span');
    summaryAuthor.dataset.sttAuthor = '';
    summaryAuthor.textContent = '@待获取';
    const summaryText = document.createElement('span');
    summaryText.dataset.sttText = '';
    summaryText.className = 'stt-tweet-text';
    summaryText.textContent = '正文将在数据接入后显示。';
    summary.append(summaryTitle, summaryId, summaryAuthor, summaryText);

    const status = document.createElement('p');
    status.className = 'stt-sheet-status';
    status.textContent = '当前为界面骨架，媒体与推文数据将在后续阶段接入。';

    const actions = document.createElement('div');
    actions.className = 'stt-sheet-actions';
    actions.append(
      this.createDisabledAction('保存媒体', '媒体下载将在后续阶段接入。'),
      this.createDisabledAction('生成画框图片', '画框生成将在后续阶段接入。'),
      this.createDisabledAction('复制推文文本', '文本导出将在后续阶段接入。')
    );

    dialog.append(header, summary, status, actions);
    backdrop.append(dialog);
    root.append(backdrop);
    return root;
  }

  private createCloseIcon(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.25');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    svg.append(path);
    return svg;
  }

  private createDisabledAction(label: string, description: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'stt-sheet-action';

    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = true;
    button.textContent = label;

    const detail = document.createElement('span');
    detail.textContent = description;

    wrapper.append(button, detail);
    return wrapper;
  }

  private openSheet(): void {
    if (!this.sheet) return;
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    this.sheet.hidden = false;
    delete this.sheet.dataset.state;
    requestAnimationFrame(() => {
      if (this.sheet && !this.sheet.hidden) this.sheet.dataset.state = 'open';
    });
    this.sheet.querySelector<HTMLButtonElement>('[data-stt-close]')?.focus({ preventScroll: true });
  }

  private closeSheet(immediate = false): void {
    if (!this.sheet) return;
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }

    if (immediate) {
      this.sheet.hidden = true;
      delete this.sheet.dataset.state;
    } else if (!this.sheet.hidden) {
      this.sheet.dataset.state = 'closing';
      this.closeTimer = window.setTimeout(() => {
        if (!this.sheet) return;
        this.sheet.hidden = true;
        delete this.sheet.dataset.state;
        this.closeTimer = undefined;
      }, 160);
    }

    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus({ preventScroll: true });
    }
    this.previousFocus = undefined;
  }

  private removeEntry(): void {
    this.closeSheet(true);
    this.sheet?.remove();
    this.actionHost?.remove();
    this.sheet = undefined;
    this.actionHost = undefined;
    this.trigger = undefined;
    this.currentTweetId = undefined;
    this.currentArticle = undefined;
  }
}
