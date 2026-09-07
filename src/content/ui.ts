import { buildFrameFilename, buildMediaFilename } from '../core/filename.js';
import { downloadBlob, downloadMedia as downloadMediaFile } from '../core/download.js';
import { renderPhotoFrame } from '../core/frame.js';
import { copyTweetText } from '../core/text-export.js';
import { getTweetIdFromPath } from '../shared/model.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { DEFAULT_SETTINGS, loadSettings, type ExtensionSettings } from '../shared/settings.js';
import { TweetSource } from './tweet-source.js';

const ROUTE_CHANGE_EVENT = 'share-this-tweet:route-change';
const ACTION_HOST_ATTRIBUTE = 'data-stt-action-host';
const SHEET_ID = 'stt-bottom-sheet';

type MediaActionState = 'idle' | 'loading' | 'success' | 'error';
type IconName = 'share' | 'close' | 'frame' | 'download' | 'copy' | 'photo' | 'video' | 'check' | 'arrow';
const ICON_PATHS: Record<IconName, string> = {
  share: 'M13 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M4 16h16M15 3h6v6M21 3l-8 8',
  close: 'M6 6l12 12M18 6L6 18', frame: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 16h18M7 12l3-3 4 4 3-3 4 4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  copy: 'M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3',
  photo: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 16l6-6 6 6 3-3 3 3M15 7h.01',
  video: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM10 8l6 4-6 4Z',
  check: 'M5 12l4 4L19 6', arrow: 'M7 17 17 7M7 7h10v10'
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]); path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path); return svg;
}

function extensionIcon(size: 'small' | 'brand'): HTMLImageElement {
  const image = document.createElement('img');
  image.className = size === 'brand' ? 'stt-brand-icon' : 'stt-extension-icon';
  image.src = browser.runtime.getURL(size === 'brand' ? '/icons/icon-48.png' : '/icons/icon-32.png');
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
    url.searchParams.set('name', 'small'); return url.href;
  } catch { return undefined; }
}
function sourceURL(record: TweetRecord): string {
  try {
    const url = new URL(record.url || '');
    if (url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return url.href;
  } catch { /* Fall back to the stable post identifier. */ }
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
  private readonly frameActionStates = new Map<number, MediaActionState>();
  private readonly frameActionErrors = new Map<number, string>();
  private textActionState: MediaActionState = 'idle';
  private textActionError = '';
  private selectedMediaIndex?: number;
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
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeSheet(); return; }
    if (event.key !== 'Tab') return;
    const focusable = this.focusableElements();
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first || !last) { event.preventDefault(); this.sheet.querySelector<HTMLElement>('.stt-sheet')?.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !this.sheet.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !this.sheet.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  };
  private readonly onFocusIn = (event: FocusEvent): void => {
    if (this.sheet && !this.sheet.hidden && this.sheet.dataset.state !== 'closing' &&
        event.target instanceof Node && !this.sheet.contains(event.target)) {
      this.sheet.querySelector<HTMLButtonElement>('[data-stt-close]')?.focus({ preventScroll: true });
    }
  };
  private focusableElements(): HTMLElement[] {
    return Array.from(this.sheet?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])
      .filter(item => item.getClientRects().length > 0 && !item.closest('[hidden]'));
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
      subtree: true
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
      this.setSheetStatus('error', '无法获取当前推文数据，请刷新页面后重试。');
      console.error('分享有据 · Share This Tweet: failed to resolve tweet record', error);
    } finally {
      if (requestId === this.recordRequestId) this.trigger?.removeAttribute('aria-busy');
    }
  }

  private applyTweetRecord(record: TweetRecord): void {
    const firstRecord = !this.currentRecord;
    this.currentRecord = record;
    if (!record.media.some(media => media.index === this.selectedMediaIndex)) this.selectedMediaIndex = record.media[0]?.index;
    const summary = this.sheet?.querySelector<HTMLElement>('.stt-tweet-summary');
    if (!summary) return;
    const update = (selector: string, value: string): void => { const item = summary.querySelector<HTMLElement>(selector); if (item) item.textContent = value; };
    const handle = record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : '账号未知';
    const name = record.author.name || handle;
    update('[data-stt-author]', name);
    update('[data-stt-handle]', handle);
    update('[data-stt-avatar]', Array.from(name.replace(/^@/, ''))[0] || 'X');
    update('[data-stt-tweet-id]', record.tweetId);
    update('[data-stt-text]', record.text || '这条推文没有正文。');
    const date = record.publishedAt ? new Date(record.publishedAt) : undefined;
    update('[data-stt-date]', date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
      : '发布时间暂不可用');
    const link = summary.querySelector<HTMLAnchorElement>('[data-stt-source-link]');
    if (link) { link.href = sourceURL(record); link.textContent = '查看原推'; }
    const expander = summary.querySelector<HTMLButtonElement>('[data-stt-expand-text]');
    if (expander) expander.hidden = (record.text || '').length < 70 && (record.text || '').split('\n').length < 3;
    this.trigger?.removeAttribute('aria-busy');
    this.renderActions(this.currentRecord ?? record);
    if (firstRecord) this.setSheetStatus('ready', '');
  }

  private setSheetStatus(state: 'loading' | 'ready' | 'error', message: string): void {
    if (!this.sheet) return;
    this.sheet.dataset.dataState = state;
    const status = this.sheet.querySelector<HTMLElement>('.stt-sheet-status');
    if (status) { status.textContent = message; status.hidden = !message; }
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
    const root = node('div', 'stt-sheet-root'); root.id = SHEET_ID; root.hidden = true;
    const backdrop = node('div', 'stt-sheet-backdrop');
    backdrop.addEventListener('click', event => { if (event.target === backdrop) this.closeSheet(); });
    const dialog = node('section', 'stt-sheet'); dialog.tabIndex = -1;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'stt-sheet-title');
    const header = node('header', 'stt-sheet-header');
    const titleGroup = node('div', 'stt-title-group');
    const brand = node('span', 'stt-brand-mark'); brand.append(extensionIcon('brand'));
    const headings = node('div', 'stt-headings');
    headings.append(node('p', 'stt-brand-name', '分享有据 · Share This Tweet'));
    const title = node('h2', '', '分享这条推文'); title.id = 'stt-sheet-title'; headings.append(title);
    titleGroup.append(brand, headings);
    const close = node('button', 'stt-sheet-close'); close.type = 'button'; close.dataset.sttClose = '';
    close.setAttribute('aria-label', '关闭分享面板'); close.append(icon('close'));
    close.addEventListener('click', () => this.closeSheet()); header.append(titleGroup, close);
    const scroll = node('div', 'stt-sheet-scroll');
    const summary = node('div', 'stt-tweet-summary');
    const authorRow = node('div', 'stt-author-row');
    const avatar = node('span', 'stt-avatar'); avatar.dataset.sttAvatar = ''; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = 'X';
    const authorNames = node('div', 'stt-author-names');
    const author = node('strong', '', '正在读取推文'); author.dataset.sttAuthor = '';
    const handle = node('span', 'stt-handle', ''); handle.dataset.sttHandle = '';
    authorNames.append(author, handle); authorRow.append(avatar, authorNames, node('span', 'stt-source-badge', 'X'));
    const text = node('p', 'stt-tweet-text', '内容准备好后，就可以保存或复制。'); text.dataset.sttText = ''; text.id = 'stt-summary-text';
    const expander = node('button', 'stt-expand-text', '展开正文'); expander.type = 'button'; expander.dataset.sttExpandText = ''; expander.hidden = true;
    expander.setAttribute('aria-expanded', 'false'); expander.setAttribute('aria-controls', text.id);
    expander.addEventListener('click', () => {
      const expanded = expander.getAttribute('aria-expanded') !== 'true';
      expander.setAttribute('aria-expanded', String(expanded)); expander.textContent = expanded ? '收起正文' : '展开正文';
      text.classList.toggle('stt-expanded', expanded);
    });
    const provenance = node('details', 'stt-provenance');
    provenance.append(node('summary', '', '来源信息'));
    const dl = node('dl', '');
    const id = node('dd', '', tweetId); id.dataset.sttTweetId = '';
    const date = node('dd', '', '待读取'); date.dataset.sttDate = '';
    dl.append(node('dt', '', '推文 ID'), id, node('dt', '', '发布时间'), date);
    const sourceLink = node('a', 'stt-source-link', '查看原推'); sourceLink.dataset.sttSourceLink = '';
    sourceLink.href = `https://x.com/i/status/${encodeURIComponent(tweetId)}`;
    sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer'; provenance.append(dl, sourceLink);
    summary.append(authorRow, text, expander, provenance);
    const actions = node('div', 'stt-sheet-actions');
    actions.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-stt-action]') : null;
      if (!target || !actions.contains(target) || target.disabled) return;
      event.preventDefault();
      const action = target.dataset.sttAction;
      if (action === 'copy-text') { void this.copyText(); return; }
      const index = Number(target.dataset.sttMediaIndex);
      if (!Number.isInteger(index)) return;
      if (action === 'select-media') { this.selectedMediaIndex = index; if (this.currentRecord) this.renderActions(this.currentRecord); }
      else if (action === 'download-media') void this.saveMedia(index);
      else if (action === 'frame-media') void this.generateFrame(index);
    });
    const skeleton = node('div', 'stt-action-skeleton', '正在准备分享选项…'); skeleton.setAttribute('aria-hidden', 'true'); actions.append(skeleton);
    scroll.append(summary, actions);
    const status = node('p', 'stt-sheet-status', '正在读取推文…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    const footer = node('footer', 'stt-sheet-footer'); footer.append(status, node('p', 'stt-sheet-note', '分享喜欢，也留下出处。'));
    dialog.append(header, scroll, footer); backdrop.append(dialog); root.append(backdrop); return root;
  }

  private renderActions(record: TweetRecord): void {
    const actions = this.sheet?.querySelector<HTMLElement>('.stt-sheet-actions');
    if (!actions) return;
    const active = document.activeElement instanceof HTMLElement && actions.contains(document.activeElement) ? document.activeElement : undefined;
    const focusKey = active?.dataset.sttFocusKey;
    const filenameOpen = actions.querySelector<HTMLDetailsElement>('.stt-file-details')?.open ?? false;
    const scroll = this.sheet?.querySelector<HTMLElement>('.stt-sheet-scroll');
    const scrollTop = scroll?.scrollTop ?? 0;
    const stripScroll = actions.querySelector<HTMLElement>('.stt-media-strip')?.scrollLeft ?? 0;
    actions.replaceChildren();
    if (record.media.length > 0) {
      if (!record.media.some(media => media.index === this.selectedMediaIndex)) this.selectedMediaIndex = record.media[0]?.index;
      const selectionHeading = node('div', 'stt-section-label');
      const position = record.media.findIndex(media => media.index === this.selectedMediaIndex) + 1;
      selectionHeading.append(node('span', '', record.media.length > 1 ? '选择要分享的内容' : '这条推文的内容'), node('span', 'stt-selection-count', `${position} / ${record.media.length}`));
      actions.append(selectionHeading);
      const strip = node('div', 'stt-media-strip'); strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', '选择媒体');
      record.media.forEach(media => {
        const selected = media.index === this.selectedMediaIndex;
        const choice = node('button', 'stt-media-choice'); choice.type = 'button'; choice.dataset.sttAction = 'select-media';
        choice.dataset.sttMediaIndex = String(media.index); choice.dataset.sttFocusKey = `select-${media.index}`;
        choice.setAttribute('aria-pressed', String(selected));
        const label = media.type === 'photo' ? '照片' : media.type === 'animated_gif' ? 'GIF' : '视频';
        choice.setAttribute('aria-label', `${label} ${media.index}`);
        const thumb = node('span', 'stt-media-thumb');
        thumb.append(icon(media.type === 'photo' ? 'photo' : 'video'));
        const url = thumbnailURL(media);
        if (url) {
          const img = node('img', ''); img.src = url; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', () => img.remove(), { once: true }); thumb.append(img);
        }
        const check = node('span', 'stt-thumb-check'); check.append(icon('check')); thumb.append(check);
        choice.append(thumb, node('span', 'stt-media-label', `${label} ${media.index}`)); strip.append(choice);
      });
      actions.append(strip);
      const selected = record.media.find(media => media.index === this.selectedMediaIndex);
      if (selected) actions.append(this.createMediaAction(record, selected));
    }
    actions.append(this.createTextAction(record.media.length === 0));
    const details = actions.querySelector<HTMLDetailsElement>('.stt-file-details'); if (details) details.open = filenameOpen;
    const newStrip = actions.querySelector<HTMLElement>('.stt-media-strip'); if (newStrip) newStrip.scrollLeft = stripScroll;
    if (scroll) scroll.scrollTop = scrollTop;
    if (focusKey) {
      const target = Array.from(actions.querySelectorAll<HTMLElement>('[data-stt-focus-key]')).find(item => item.dataset.sttFocusKey === focusKey);
      if (target instanceof HTMLButtonElement && !target.disabled) target.focus({ preventScroll: true });
      else if (target) {
        // While an action is disabled, keep keyboard focus inside the dialog.
        if (target.parentElement) {
          target.parentElement.dataset.sttFocusKey = focusKey;
          target.parentElement.setAttribute('tabindex', '-1'); target.parentElement.focus({ preventScroll: true });
        }
      }
    }
  }

  private actionButton(action: string, focusKey: string, label: string, description: string, image: IconName, state: MediaActionState, primary = false): HTMLButtonElement {
    const button = node('button', `stt-command${primary ? ' stt-command-primary' : ''}`);
    button.type = 'button'; button.dataset.sttAction = action; button.dataset.sttFocusKey = focusKey; button.dataset.state = state;
    button.disabled = state === 'loading'; button.setAttribute('aria-busy', String(state === 'loading'));
    const glyph = node('span', 'stt-command-icon'); glyph.append(icon(state === 'success' ? 'check' : image));
    const copy = node('span', 'stt-command-copy'); copy.append(node('strong', '', label), node('span', '', description));
    const end = node('span', 'stt-command-end'); end.append(icon(state === 'loading' ? 'download' : 'arrow'));
    button.append(glyph, copy, end); return button;
  }

  private createTextAction(primary = false): HTMLElement {
    const wrapper = node('div', 'stt-text-action'); wrapper.dataset.state = this.textActionState;
    const state = this.textActionState;
    const label = state === 'loading' ? '正在复制…' : state === 'success' ? '已复制 · 再复制一次' : state === 'error' ? '重试复制文字' : '复制推文文字';
    wrapper.append(this.actionButton('copy-text', 'copy-text', label, '复制后，直接粘贴到聊天中', 'copy', state, primary));
    if (state === 'error') wrapper.append(this.errorDetails('没能复制，请重试或检查剪贴板权限。', this.textActionError));
    return wrapper;
  }

  private errorDetails(message: string, technical: string): HTMLElement {
    const wrapper = node('div', 'stt-inline-error'); wrapper.setAttribute('role', 'status'); wrapper.append(node('p', '', message));
    if (technical) { const details = node('details', ''); details.append(node('summary', '', '查看详细信息'), node('p', '', technical)); wrapper.append(details); }
    return wrapper;
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
      if (epoch !== this.recordRequestId || this.currentTweetId !== tweetId || this.currentRecord?.tweetId !== tweetId) return;
      this.textActionState = 'success';
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('ready', '已复制，可直接粘贴到聊天中。');
    } catch (error) {
      if (epoch !== this.recordRequestId || this.currentTweetId !== tweetId || this.currentRecord?.tweetId !== tweetId) return;
      this.textActionState = 'error';
      this.textActionError = error instanceof Error ? error.message : String(error);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能复制，请查看详情后重试。');
      console.error('分享有据 · Share This Tweet: failed to copy tweet text', error);
    }
  }

  private createMediaAction(record: TweetRecord, media: MediaRecord): HTMLElement {
    const wrapper = node('div', 'stt-media-action');
    const state = this.mediaActionStates.get(media.index) ?? 'idle';
    const frameState = this.frameActionStates.get(media.index) ?? 'idle';
    wrapper.dataset.state = state;
    const photo = media.type === 'photo';
    if (photo) {
      const label = frameState === 'loading' ? '正在制作来源画框…' : frameState === 'success' ? '再保存一张带来源的图片' : frameState === 'error' ? '重试保存带来源图片' : '保存带来源的图片';
      const frame = this.actionButton('frame-media', `frame-${media.index}`, label, '照片 + 署名画框 · PNG', 'frame', frameState, true);
      frame.classList.add('stt-media-frame-button'); frame.dataset.sttMediaIndex = String(media.index); wrapper.append(frame);
      if (frameState === 'error') wrapper.append(this.errorDetails('这张画框没能生成，请重试。', this.frameActionErrors.get(media.index) ?? ''));
    }
    const mediaLabel = photo ? '原图' : media.type === 'animated_gif' ? 'GIF 视频' : '视频';
    const label = state === 'loading' ? '正在保存…' : state === 'success' ? `再次保存${mediaLabel}` : state === 'error' ? `重试保存${mediaLabel}` : `保存${mediaLabel}`;
    const button = this.actionButton('download-media', `download-${media.index}`, label,
      photo ? '不加画框，保留原始图片' : media.type === 'animated_gif' ? '以 MP4 格式保存，不转换成 .gif' : '以 MP4 格式保存',
      'download', state, !photo);
    button.dataset.sttMediaIndex = String(media.index);
    let filename = '';
    try { filename = buildMediaFilename(record, media, this.settings.filenameTemplate); }
    catch (error) {
      button.disabled = true;
      wrapper.append(this.errorDetails('请先检查设置中的文件名模板。', error instanceof Error ? error.message : String(error)));
    }
    wrapper.append(button);
    if (state === 'error') wrapper.append(this.errorDetails('没能保存，请检查网络后重试。', this.mediaActionErrors.get(media.index) ?? ''));
    if (filename) {
      const details = node('details', 'stt-file-details'); details.append(node('summary', '', '查看保存文件名'));
      const list = node('dl', ''); list.append(node('dt', '', photo ? '原图' : '视频'), node('dd', '', filename));
      if (photo) {
        try { list.append(node('dt', '', '画框'), node('dd', '', buildFrameFilename(record, media, this.settings.filenameTemplate))); }
        catch { list.append(node('dt', '', '画框'), node('dd', '', '文件名暂不可用，请检查模板。')); }
      }
      details.append(list); wrapper.append(details);
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
      if (epoch !== this.recordRequestId || this.currentTweetId !== tweetId || this.currentRecord?.tweetId !== tweetId) return;
      this.mediaActionStates.set(mediaIndex, 'success');
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('ready', '已交给浏览器保存，可在下载列表中查看。');
    } catch (error) {
      if (epoch !== this.recordRequestId || this.currentTweetId !== tweetId || this.currentRecord?.tweetId !== tweetId) return;
      const message = error instanceof Error ? error.message : String(error);
      this.mediaActionStates.set(mediaIndex, 'error');
      this.mediaActionErrors.set(mediaIndex, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能保存，请在下方查看详情后重试。');
      console.error('分享有据 · Share This Tweet: failed to download media', error);
    }
  }

  private async generateFrame(mediaIndex: number): Promise<void> {
    const record = this.currentRecord;
    const media = record?.media.find((candidate) => candidate.index === mediaIndex);
    if (!record || !media || media.type !== 'photo') return;
    const state = this.frameActionStates.get(mediaIndex) ?? 'idle';
    if (state === 'loading') return;

    let filename: string;
    try {
      filename = buildFrameFilename(record, media, this.settings.filenameTemplate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.frameActionStates.set(mediaIndex, 'error');
      this.frameActionErrors.set(mediaIndex, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能生成画框，请查看详情后重试。');
      return;
    }

    const tweetId = record.tweetId;
    const epoch = this.recordRequestId;
    this.frameActionStates.set(mediaIndex, 'loading');
    this.frameActionErrors.delete(mediaIndex);
    this.renderActions(this.currentRecord ?? record);
    this.setSheetStatus('loading', `正在生成第 ${media.index} 项画框…`);

    try {
      const blob = await renderPhotoFrame(record, media, this.settings.frameTemplate);
      if (epoch !== this.recordRequestId || this.currentTweetId !== tweetId || this.currentRecord?.tweetId !== tweetId) return;
      downloadBlob(blob, filename);
      this.frameActionStates.set(mediaIndex, 'success');
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('ready', '带来源的图片已生成，并交给浏览器保存。');
    } catch (error) {
      if (epoch !== this.recordRequestId || this.currentTweetId !== tweetId || this.currentRecord?.tweetId !== tweetId) return;
      const message = error instanceof Error ? error.message : String(error);
      this.frameActionStates.set(mediaIndex, 'error');
      this.frameActionErrors.set(mediaIndex, message);
      this.renderActions(this.currentRecord ?? record);
      this.setSheetStatus('error', '这次没能生成画框，请查看详情后重试。');
      console.error('分享有据 · Share This Tweet: failed to render photo frame', error);
    }
  }

  private lockPage(): void {
    if (this.restoreOverlay || !this.sheet) return;
    const siblings = Array.from(document.body.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== this.sheet);
    const inertState = siblings.map(element => ({ element, inert: element.inert }));
    for (const { element } of inertState) element.inert = true;
    const targets = [document.documentElement, document.body];
    const overflow = targets.map(element => ({ element, value: element.style.getPropertyValue('overflow'), priority: element.style.getPropertyPriority('overflow') }));
    for (const { element } of overflow) element.style.setProperty('overflow', 'hidden', 'important');
    this.restoreOverlay = () => {
      for (const { element, inert } of inertState) element.inert = inert;
      for (const { element, value, priority } of overflow) {
        if (value) element.style.setProperty('overflow', value, priority); else element.style.removeProperty('overflow');
      }
    };
  }

  private openSheet(): void {
    if (!this.sheet) return;
    if (!this.sheet.hidden && this.sheet.dataset.state !== 'closing') return;
    if (this.closeTimer !== undefined) { window.clearTimeout(this.closeTimer); this.closeTimer = undefined; }
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.sheet.hidden = false; delete this.sheet.dataset.state;
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.lockPage();
    requestAnimationFrame(() => { if (this.sheet && !this.sheet.hidden && this.sheet.dataset.state !== 'closing') this.sheet.dataset.state = 'open'; });
    this.sheet.querySelector<HTMLButtonElement>('[data-stt-close]')?.focus({ preventScroll: true });
    // Refresh saved preferences when reopening; never cache old settings for the
    // entire lifetime of an X tab.
    void this.loadSettings();
  }

  private closeSheet(immediate = false): void {
    if (!this.sheet) return;
    if (this.closeTimer !== undefined) { window.clearTimeout(this.closeTimer); this.closeTimer = undefined; }
    this.sheet.dataset.state = 'closing';
    this.trigger?.setAttribute('aria-expanded', 'false');
    this.restoreOverlay?.(); this.restoreOverlay = undefined;
    if (immediate) { this.sheet.hidden = true; delete this.sheet.dataset.state; }
    else if (!this.sheet.hidden) {
      this.closeTimer = window.setTimeout(() => {
        if (!this.sheet) return;
        this.sheet.hidden = true; delete this.sheet.dataset.state; this.closeTimer = undefined;
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
    this.recordRequestId += 1;
    this.mediaActionStates.clear();
    this.mediaActionErrors.clear();
    this.frameActionStates.clear();
    this.frameActionErrors.clear();
    this.textActionState = 'idle';
    this.textActionError = '';
    this.currentTweetId = undefined;
    this.currentArticle = undefined;
  }
}
