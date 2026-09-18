import { afterEach, expect, it, vi } from 'vitest';
import { ExportSession } from '../src/content/export-session.js';
import { renderActions } from '../src/content/actions-view.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { TweetRecord } from '../src/shared/model.js';

// Minimal DOM surface for exercising event routing, not CSS or product copy.
class Element extends EventTarget {
  children: Element[] = [];
  parentElement?: Element;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  hidden = false;
  disabled = false;
  open = false;
  scrollLeft = 0;
  scrollTop = 0;
  constructor(
    readonly tag: string,
    readonly className = '',
  ) {
    super();
  }
  append(...items: Element[]) {
    for (const item of items) {
      item.parentElement = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: Element[]) {
    this.children = [];
    this.append(...items);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name);
  }
  contains(element: Element): boolean {
    return this === element || this.children.some((child) => child.contains(element));
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (item: Element) =>
      selector.startsWith('.')
        ? item.className.split(' ').includes(selector.slice(1))
        : selector === '[data-stt-focus-key]'
          ? !!item.dataset.sttFocusKey
          : item.tag === selector;
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0];
  }
  focus() {
    documentState.activeElement = this;
  }
  click() {
    if (!this.disabled) {
      this.focus();
      this.dispatchEvent(new Event('click'));
    }
  }
}
const documentState: { activeElement?: Element } = {};
vi.mock('../src/content/ui-components.js', () => ({
  node: (tag: string, className: string) => new Element(tag, className),
  icon: () => new Element('svg'),
  thumbnailURL: () => undefined,
  actionLabel: () => '',
  errorDetails: () => new Element('details'),
  actionButton: (options: {
    key: string;
    disabled?: boolean;
    state: { status: string };
    onClick: () => void;
  }) => {
    const button = new Element('button');
    button.dataset.sttFocusKey = options.key;
    button.disabled = !!options.disabled || options.state.status === 'loading';
    button.addEventListener('click', options.onClick);
    return button;
  },
}));
function setup() {
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('HTMLButtonElement', Element);
  vi.stubGlobal('document', documentState);
  const sheet = new Element('section');
  const scroll = new Element('div', 'stt-sheet-scroll');
  const actions = new Element('div', 'stt-sheet-actions');
  const dock = new Element('div', 'stt-mobile-dock');
  scroll.append(actions);
  sheet.append(scroll, dock);
  const render = (session: ExportSession, mobile = true) =>
    renderActions(sheet as unknown as HTMLElement, session, mobile);
  const button = (key: string) => {
    const result = sheet
      .querySelectorAll('[data-stt-focus-key]')
      .find((item) => item.dataset.sttFocusKey === key);
    if (!result) throw new Error(`Missing action: ${key}`);
    return result;
  };
  return { sheet, actions, dock, render, button };
}
const tweet = (tweetId: string): TweetRecord => ({
  tweetId,
  url: `https://x.com/a/status/${tweetId}`,
  author: { id: '1', handle: 'a', name: 'A' },
  text: '',
  media: [1, 2].map((index) => ({
    index,
    type: 'photo',
    originalUrl: `https://pbs.twimg.com/${tweetId}_${index}.jpg`,
  })),
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  documentState.activeElement = undefined;
});
it('routes pinned media actions to the active tweet, keeps each selection, and exports whole cards from the parent', () => {
  const ui = setup();
  const record = {
    ...tweet('1'),
    quote: { tweetId: '2', status: 'available' as const, record: tweet('2') },
  };
  const session = new ExportSession(record, DEFAULT_SETTINGS);
  const saveMain = vi.spyOn(session, 'saveSelected').mockResolvedValue();
  const saveQuote = vi.spyOn(session.quoted!, 'saveSelected').mockResolvedValue();
  const stitchQuote = vi.spyOn(session.quoted!, 'stitchMedia').mockResolvedValue();
  const card = vi.spyOn(session, 'saveCard').mockResolvedValue();
  const copy = vi.spyOn(session, 'copyText').mockResolvedValue();
  ui.render(session);
  expect(ui.dock.contains(ui.button('save-media-1'))).toBe(true);
  ui.button('select-1-2').click();
  ui.render(session);
  ui.button('scope-quote').click();
  expect(ui.dock.contains(ui.button('save-media-2'))).toBe(true);
  ui.button('select-2-1').click();
  ui.button('select-2-2').click();
  ui.render(session);
  ui.button('save-media-2').click();
  ui.button('stitch-media-2').click();
  ui.button('save-row-card').click();
  ui.button('copy-text').click();
  expect(saveQuote).toHaveBeenCalledWith('configured');
  expect(stitchQuote).toHaveBeenCalledOnce();
  expect(saveMain).not.toHaveBeenCalled();
  expect(card).toHaveBeenCalledWith(true);
  expect(copy).toHaveBeenCalledOnce();
  ui.button('scope-main').click();
  expect(session.selection.selected(session.record.media).map((item) => item.index)).toEqual([
    1, 2,
  ]);
  expect(
    session.quoted!.selection.selected(session.quoted!.record.media).map((item) => item.index),
  ).toEqual([2]);
  ui.render(session, false);
  expect(ui.dock.hidden).toBe(true);
  expect(ui.actions.contains(ui.button('save-media-1'))).toBe(true);
  expect(ui.actions.contains(ui.button('save-media-2'))).toBe(true);
});
it('omits media commands for an unavailable quote and restores them when quote data arrives', () => {
  const ui = setup();
  const record = { ...tweet('1'), quote: { tweetId: '2', status: 'pending' as const } };
  const session = new ExportSession(record, DEFAULT_SETTINGS);
  ui.render(session);
  ui.button('scope-quote').click();
  expect(
    ui.dock
      .querySelectorAll('[data-stt-focus-key]')
      .some((item) => item.dataset.sttFocusKey.startsWith('save-media-')),
  ).toBe(false);
  session.updateRecord({
    ...record,
    quote: { tweetId: '2', status: 'available', record: tweet('2') },
  });
  ui.render(session);
  expect(ui.dock.contains(ui.button('save-media-2'))).toBe(true);
});

it.each([true, false])(
  'keeps the shared frame selector available for dynamic-only and empty selections, mobile=%s',
  (mobile) => {
    const ui = setup();
    const record: TweetRecord = {
      ...tweet('1'),
      media: [
        {
          index: 1,
          type: 'video',
          variants: [{ url: 'https://video.twimg.com/1.mp4', mime: 'video/mp4' }],
        },
        {
          index: 2,
          type: 'animated_gif',
          variants: [{ url: 'https://video.twimg.com/2.mp4', mime: 'video/mp4' }],
        },
      ],
    };
    const session = new ExportSession(record, DEFAULT_SETTINGS);
    ui.render(session, mobile);
    const hiddenKeys = ui.sheet
      .querySelectorAll('[data-stt-focus-key]')
      .map((item) => item.dataset.sttFocusKey);
    expect(hiddenKeys).not.toContain('stitch-media-1');
    expect(hiddenKeys).not.toContain('save-choice-1-video-top');
    expect(hiddenKeys).toContain('save-choice-1-video-sourced');
    session.updateSettings({ ...DEFAULT_SETTINGS, experimentalVideo: true });
    ui.render(session, mobile);
    expect(ui.button('save-choice-1-video-top').disabled).toBe(false);
    ui.button('save-choice-1-photo-top').click();
    expect(session.mediaOptions.photo).toBe('top');
    session.toggleMedia(1);
    ui.render(session, mobile);
    ui.button('save-choice-1-photo-original').click();
    expect(session.mediaOptions.photo).toBe('original');
    expect(ui.button('stitch-media-1').disabled).toBe(false);
    expect(ui.button('save-media-1').disabled).toBe(true);
  },
);
