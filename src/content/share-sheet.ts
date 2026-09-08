import type { TweetRecord } from '../shared/model.js';
import type { ExportSession } from './export-session.js';
import { renderActions } from './actions-view.js';
import { node, icon, extensionIcon, sourceURL } from './ui-components.js';

export const SHEET_ID = 'stt-bottom-sheet';

/** Owns the dialog DOM, accessibility and restoration of host-page state. */
export class ShareSheet {
  private readonly sheet: HTMLElement;
  private hasRecord = false;
  private previousFocus?: HTMLElement;
  private closeTimer?: number;
  private restoreOverlay?: () => void;

  constructor(
    tweetId: string,
    private readonly trigger: HTMLButtonElement,
    private readonly onOpen: () => void,
  ) {
    document.getElementById(SHEET_ID)?.remove();
    this.sheet = this.createSheet(tweetId);
    document.body.append(this.sheet);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('focusin', this.onFocusIn);
  }
  render(session: ExportSession): void {
    this.updateSummary(session.record);
    renderActions(this.sheet, session);
    this.setStatus(session.status.state, session.status.message);
  }
  destroy(): void {
    this.close(true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('focusin', this.onFocusIn);
    this.sheet.remove();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.sheet.hidden || this.sheet.dataset.state === 'closing') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
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
      this.sheet.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], summary, [tabindex="0"]',
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0 && !item.closest('[hidden]'));
  }

  private updateSummary(record: TweetRecord): void {
    this.hasRecord = true;
    const summary = this.sheet.querySelector<HTMLElement>('.stt-tweet-summary');
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
    this.trigger.removeAttribute('aria-busy');
  }

  setStatus(state: 'loading' | 'ready' | 'error', message: string): void {
    this.sheet.dataset.dataState = state;
    const status = this.sheet.querySelector<HTMLElement>('.stt-sheet-status');
    if (status) {
      status.textContent = message;
      status.hidden = !message;
      if (state === 'error' && !this.hasRecord) {
        const reload = node('button', 'stt-source-link', '重新加载页面');
        reload.type = 'button';
        reload.addEventListener('click', () => location.reload());
        status.append(document.createTextNode(' '), reload);
      }
    }
  }

  private createSheet(tweetId: string): HTMLElement {
    const root = node('div', 'stt-sheet-root');
    root.id = SHEET_ID;
    root.hidden = true;
    const backdrop = node('div', 'stt-sheet-backdrop');
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) this.close();
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
    const title = node('h2', '', '导出推文');
    title.id = 'stt-sheet-title';
    headings.append(title);
    titleGroup.append(brand, headings);
    const close = node('button', 'stt-sheet-close');
    close.type = 'button';
    close.dataset.sttClose = '';
    close.setAttribute('aria-label', '关闭分享面板');
    close.append(icon('close'));
    close.addEventListener('click', () => this.close());
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
    const skeleton = node('div', 'stt-action-skeleton', '正在准备导出选项…');
    skeleton.setAttribute('aria-hidden', 'true');
    actions.append(skeleton);
    scroll.append(summary, actions);
    const status = node('p', 'stt-sheet-status', '正在读取推文…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const footer = node('footer', 'stt-sheet-footer');
    footer.append(status);
    dialog.append(header, scroll, footer);
    backdrop.append(dialog);
    root.append(backdrop);
    return root;
  }

  private lockPage(): void {
    if (this.restoreOverlay) return;
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

  open(): void {
    if (!this.sheet.hidden && this.sheet.dataset.state !== 'closing') return;
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.sheet.hidden = false;
    delete this.sheet.dataset.state;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.lockPage();
    requestAnimationFrame(() => {
      if (!this.sheet.hidden && this.sheet.dataset.state !== 'closing')
        this.sheet.dataset.state = 'open';
    });
    this.sheet.querySelector<HTMLButtonElement>('[data-stt-close]')?.focus({ preventScroll: true });
    // Refresh saved preferences when reopening; never cache old settings for the
    // entire lifetime of an X tab.
    this.onOpen();
  }

  close(immediate = false): void {
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.sheet.dataset.state = 'closing';
    this.trigger.setAttribute('aria-expanded', 'false');
    this.restoreOverlay?.();
    this.restoreOverlay = undefined;
    if (immediate) {
      this.sheet.hidden = true;
      delete this.sheet.dataset.state;
    } else if (!this.sheet.hidden) {
      this.closeTimer = window.setTimeout(() => {
        this.sheet.hidden = true;
        delete this.sheet.dataset.state;
        this.closeTimer = undefined;
      }, 180);
    }
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = undefined;
  }
}
