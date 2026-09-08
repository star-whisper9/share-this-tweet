import { getTweetIdFromPath } from '../shared/model.js';
import { extensionIcon, node } from './ui-components.js';
import { SHEET_ID } from './share-sheet.js';

const ACTION_HOST_ATTRIBUTE = 'data-stt-action-host';
const ROUTE_CHANGE_EVENT = 'share-this-tweet:route-change';
export interface TweetEntry {
  host: HTMLElement;
  button: HTMLButtonElement;
}

export function observeTweetPage(onChange: () => void): () => void {
  const previousPushState = history.pushState;
  const previousReplaceState = history.replaceState;
  const notify = (): void => {
    window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  };
  history.pushState = (...args) => {
    previousPushState.apply(history, args);
    notify();
  };
  history.replaceState = (...args) => {
    previousReplaceState.apply(history, args);
    notify();
  };
  window.addEventListener('popstate', onChange);
  window.addEventListener(ROUTE_CHANGE_EVENT, onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(ROUTE_CHANGE_EVENT, onChange);
    history.pushState = previousPushState;
    history.replaceState = previousReplaceState;
  };
}

export function findPrimaryArticle(tweetId: string): HTMLElement | undefined {
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

export function mountEntry(article: HTMLElement, onOpen: () => void): TweetEntry {
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
    onOpen();
  });

  host.replaceChildren(button);
  if (!host.isConnected) target.append(host);
  return { host, button };
}
