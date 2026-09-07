import { getTweetIdFromPath } from '../shared/model.js';

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
    summaryId.textContent = `Tweet ID: ${tweetId}`;
    const summaryAuthor = document.createElement('span');
    summaryAuthor.textContent = '@待获取';
    summary.append(summaryTitle, summaryId, summaryAuthor);

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
