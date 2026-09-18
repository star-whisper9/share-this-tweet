import type { TweetRecord } from '../shared/model.js';
import { getLocale, t } from '../shared/i18n.js';
import type { ExportSession } from './export-session.js';
import { renderActions } from './actions-view.js';
import { node, icon, extensionIcon, sourceURL } from './ui-components.js';

export const SHEET_ID = 'stt-bottom-sheet';

/** Owns the dialog DOM, accessibility and restoration of host-page state. */
export class ShareSheet {
  private readonly sheet: HTMLElement;
  private hasRecord = false;
  private readonly mobileQuery = matchMedia('(max-width: 719px)');
  private previewExpanded = false;
  private session?: ExportSession;
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
    this.updateLayout();
    this.mobileQuery.addEventListener('change', this.onLayoutChange);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('focusin', this.onFocusIn);
  }
  render(session: ExportSession): void {
    this.sheet.lang = getLocale();
    this.updateLayout();
    this.session = session;
    this.updateSummary(session.record);
    renderActions(this.sheet, session, this.mobileQuery.matches);
    this.setStatus(session.status.state, session.status.message);
  }
  relocalize(): void {
    const update = (selector: string, value: string): void => {
      const element = this.sheet.querySelector<HTMLElement>(selector);
      if (element) element.textContent = value;
    };
    update('.stt-brand-name', t('content.brand'));
    update('#stt-sheet-title', t('content.sheetTitle'));
    const close = this.sheet.querySelector<HTMLButtonElement>('[data-stt-close]');
    close?.setAttribute('aria-label', t('content.closeSheet'));
    if (!this.hasRecord) {
      update('[data-stt-author]', t('content.readingTweet'));
      update('[data-stt-text]', t('content.readyToExport'));
      update('.stt-action-skeleton', t('content.readingOptions'));
    }
    update('.stt-provenance > summary', t('content.provenance'));
    update('.stt-provenance dt', t('content.tweetId'));
    const dateLabel = this.sheet.querySelectorAll<HTMLElement>('.stt-provenance dt')[1];
    if (dateLabel) dateLabel.textContent = t('content.publishedAt');
    const sourceLink = this.sheet.querySelector<HTMLAnchorElement>('[data-stt-source-link]');
    if (sourceLink) sourceLink.textContent = t('content.viewOriginal');
    if (this.session) this.render(this.session);
    else this.updateLayout();
  }
  destroy(): void {
    this.close(true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('focusin', this.onFocusIn);
    this.mobileQuery.removeEventListener('change', this.onLayoutChange);
    this.session = undefined;
    this.sheet.remove();
  }

  private readonly onLayoutChange = (): void => {
    this.updateLayout();
    if (this.session) this.render(this.session);
  };

  private updateLayout(): void {
    const mobile = this.mobileQuery.matches;
    this.sheet.lang = getLocale();
    this.sheet.dataset.layout = mobile ? 'mobile' : 'desktop';
    const body = this.sheet.querySelector<HTMLElement>('.stt-preview-body');
    const toggle = this.sheet.querySelector<HTMLButtonElement>('.stt-preview-toggle');
    if (body) body.hidden = mobile && !this.previewExpanded;
    if (toggle) {
      toggle.hidden = !mobile;
      toggle.setAttribute('aria-expanded', String(this.previewExpanded));
      toggle.textContent = this.previewExpanded
        ? `${t('content.collapsePreview')} ▴`
        : `${t('content.expandPreview')} ▾`;
    }
    // Status belongs to the scrolling content on mobile, so a long failure
    // message never pushes the pinned commands off screen.
    const status = this.sheet.querySelector<HTMLElement>('.stt-sheet-status');
    const destination = this.sheet.querySelector<HTMLElement>(
      mobile ? '.stt-sheet-scroll' : '.stt-sheet-footer',
    );
    if (status && destination) destination.append(status);
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
      : t('content.unknownAccount');
    const name = record.author.name || handle;
    update('[data-stt-author]', name);
    update('[data-stt-handle]', handle);
    update('[data-stt-avatar]', Array.from(name.replace(/^@/, ''))[0] || 'X');
    update('[data-stt-tweet-id]', record.tweetId);
    update('[data-stt-text]', record.text || t('content.noText'));
    const translation = summary.querySelector<HTMLElement>('.stt-preview-translation');
    if (translation) {
      translation.hidden = record.translation?.status !== 'available';
      translation.replaceChildren();
      if (record.translation?.status === 'available')
        translation.append(
          node('span', 'stt-section-label', t('content.translation')),
          node('p', 'stt-translation-text', record.translation.text),
          node('span', 'stt-section-label', t('content.originalText')),
        );
    }
    const date = record.publishedAt ? new Date(record.publishedAt) : undefined;
    update(
      '[data-stt-date]',
      date && !Number.isNaN(date.getTime())
        ? new Intl.DateTimeFormat(getLocale(), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }).format(date)
        : t('content.publishedUnavailable'),
    );
    const link = summary.querySelector<HTMLAnchorElement>('[data-stt-source-link]');
    if (link) {
      link.href = sourceURL(record);
      link.textContent = t('content.viewOriginal');
    }
    const expander = summary.querySelector<HTMLButtonElement>('[data-stt-expand-text]');
    if (expander) {
      expander.hidden =
        (record.text || '').length < 70 && (record.text || '').split('\n').length < 3;
      expander.textContent =
        expander.getAttribute('aria-expanded') === 'true'
          ? t('content.collapseText')
          : t('content.expandText');
    }
    let quote = summary.querySelector<HTMLElement>('.stt-quote-summary');
    if (!record.quote) quote?.remove();
    else {
      if (!quote) {
        quote = node('div', 'stt-quote-summary');
        summary.querySelector('.stt-preview-body')?.append(quote);
      }
      const quoteExpanded = quote.querySelector('details')?.open;
      quote.replaceChildren(node('strong', '', t('content.quotedTweet')));
      const quoted = record.quote.record;
      if (quoted) {
        quote.append(
          node('p', '', `${quoted.author.name} · @${quoted.author.handle.replace(/^@+/, '')}`),
        );
        const details = node('details', '');
        details.append(
          node('summary', '', t('content.quotedText')),
          node('p', 'stt-quote-text', quoted.text || t('content.noText')),
        );
        details.open = quoteExpanded ?? quoted.text.length < 160;
        quote.append(details);
      } else
        quote.append(
          node(
            'p',
            '',
            record.quote.status === 'unavailable'
              ? t('content.quotedUnavailable')
              : t('content.quotedPending'),
          ),
        );
      if (record.quote.tweetId) {
        const link = node(
          'a',
          'stt-source-link',
          t('content.viewQuote', { id: record.quote.tweetId }),
        );
        link.href = `https://x.com/i/status/${encodeURIComponent(record.quote.tweetId)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        quote.append(link);
      }
    }
    this.trigger.removeAttribute('aria-busy');
  }

  setStatus(state: 'loading' | 'ready' | 'error', message: string): void {
    this.sheet.dataset.dataState = state;
    const status = this.sheet.querySelector<HTMLElement>('.stt-sheet-status');
    if (status) {
      status.textContent = message;
      status.hidden = !message;
      if (state === 'error' && !this.hasRecord) {
        const reload = node('button', 'stt-source-link', t('content.reloadPage'));
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
    headings.append(node('p', 'stt-brand-name', t('content.brand')));
    const title = node('h2', '', t('content.sheetTitle'));
    title.id = 'stt-sheet-title';
    headings.append(title);
    titleGroup.append(brand, headings);
    const close = node('button', 'stt-sheet-close');
    close.type = 'button';
    close.dataset.sttClose = '';
    close.setAttribute('aria-label', t('content.closeSheet'));
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
    const author = node('strong', '', t('content.readingTweet'));
    author.dataset.sttAuthor = '';
    const handle = node('span', 'stt-handle', '');
    handle.dataset.sttHandle = '';
    authorNames.append(author, handle);
    const previewToggle = node('button', 'stt-preview-toggle', `${t('content.tweetPreview')} ▾`);
    previewToggle.type = 'button';
    previewToggle.setAttribute('aria-controls', 'stt-preview-body');
    previewToggle.setAttribute('aria-expanded', 'false');
    previewToggle.addEventListener('click', () => {
      this.previewExpanded = !this.previewExpanded;
      this.updateLayout();
    });
    authorRow.append(avatar, authorNames, node('span', 'stt-source-badge', 'X'), previewToggle);
    const text = node('p', 'stt-tweet-text', t('content.readyToExport'));
    text.dataset.sttText = '';
    text.id = 'stt-summary-text';
    const expander = node('button', 'stt-expand-text', t('content.expandText'));
    expander.type = 'button';
    expander.dataset.sttExpandText = '';
    expander.hidden = true;
    expander.setAttribute('aria-expanded', 'false');
    expander.setAttribute('aria-controls', text.id);
    expander.addEventListener('click', () => {
      const expanded = expander.getAttribute('aria-expanded') !== 'true';
      expander.setAttribute('aria-expanded', String(expanded));
      expander.textContent = expanded ? t('content.collapseText') : t('content.expandText');
      text.classList.toggle('stt-expanded', expanded);
    });
    const provenance = node('details', 'stt-provenance');
    provenance.append(node('summary', '', t('content.provenance')));
    const dl = node('dl', '');
    const id = node('dd', '', tweetId);
    id.dataset.sttTweetId = '';
    const date = node('dd', '', t('content.readingDate'));
    date.dataset.sttDate = '';
    dl.append(
      node('dt', '', t('content.tweetId')),
      id,
      node('dt', '', t('content.publishedAt')),
      date,
    );
    const sourceLink = node('a', 'stt-source-link', t('content.viewOriginal'));
    sourceLink.dataset.sttSourceLink = '';
    sourceLink.href = `https://x.com/i/status/${encodeURIComponent(tweetId)}`;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    provenance.append(dl, sourceLink);
    const previewBody = node('div', 'stt-preview-body');
    previewBody.id = 'stt-preview-body';
    const translation = node('div', 'stt-preview-translation');
    translation.hidden = true;
    previewBody.append(translation, text, expander, provenance);
    summary.append(authorRow, previewBody);
    const actions = node('div', 'stt-sheet-actions');
    const skeleton = node('div', 'stt-action-skeleton', t('content.readingOptions'));
    skeleton.setAttribute('aria-hidden', 'true');
    actions.append(skeleton);
    scroll.append(summary, actions);
    const status = node('p', 'stt-sheet-status', t('content.readingStatus'));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const footer = node('footer', 'stt-sheet-footer');
    footer.append(status);
    const dock = node('div', 'stt-mobile-dock');
    dock.hidden = true;
    dock.setAttribute('role', 'group');
    dialog.append(header, scroll, dock, footer);
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
