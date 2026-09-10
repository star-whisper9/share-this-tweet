import type { MediaRecord, TweetRecord } from '../shared/model.js';
import type { ActionState, ActionStatus } from './export-session.js';

export type IconName =
  'share' | 'close' | 'frame' | 'download' | 'copy' | 'photo' | 'video' | 'check' | 'arrow';
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
export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
export function icon(name: IconName): SVGSVGElement {
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

export function extensionIcon(size: 'small' | 'brand'): HTMLImageElement {
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
export function thumbnailURL(media: MediaRecord): string | undefined {
  const source = media.type === 'photo' ? media.originalUrl : media.previewUrl;
  if (!source) return undefined;
  try {
    const url = new URL(source, location.href);
    if (url.protocol === 'blob:' && url.origin === location.origin) return url.href;
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com') return undefined;
    url.searchParams.set('name', 'small');
    return url.href;
  } catch {
    return undefined;
  }
}
export function sourceURL(record: TweetRecord): string {
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

export function errorDetails(message: string, technical: string): HTMLElement {
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

export function actionLabel(
  state: Readonly<ActionState>,
  labels: Record<ActionStatus, string>,
): string {
  return labels[state.status];
}
export interface ActionButtonOptions {
  key: string;
  label: string;
  description?: string;
  image: IconName;
  state: Readonly<ActionState>;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
export function actionButton(options: ActionButtonOptions): HTMLButtonElement {
  const {
    key,
    label,
    description,
    image,
    state,
    primary = false,
    disabled = false,
    onClick,
  } = options;
  const button = node('button', `stt-command${primary ? ' stt-command-primary' : ''}`);
  button.type = 'button';
  button.dataset.sttFocusKey = key;
  button.dataset.state = state.status;
  button.disabled = disabled || state.status === 'loading';
  button.setAttribute('aria-busy', String(state.status === 'loading'));
  button.addEventListener('click', () => onClick());
  const glyph = node('span', 'stt-command-icon');
  glyph.append(icon(state.status === 'success' ? 'check' : image));
  const copy = node('span', 'stt-command-copy');
  copy.append(node('strong', '', label));
  if (description) copy.append(node('span', '', description));
  const end = node('span', 'stt-command-end');
  end.hidden = state.status !== 'loading';
  button.append(glyph, copy, end);
  return button;
}
