import { CAPTURE_READY_EVENT, TWEET_DATA_EVENT } from '../shared/capture-protocol.js';
import type { TweetSource } from './tweet-source.js';

// Start listening before inserting the page script: its first response can
// arrive before either the script load event or DOMContentLoaded.
export function startTweetCapture(source: TweetSource): void {
  window.addEventListener(TWEET_DATA_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') return;
    try {
      source.ingestSerialized(detail);
    } catch (error) {
      console.error('分享有据: 推文数据解析失败', error instanceof Error ? error.name : 'Error');
    }
  });

  let ready = false;
  let script: HTMLScriptElement | undefined;
  let observer: MutationObserver | undefined;
  const timeout = window.setTimeout(() => {
    observer?.disconnect();
    if (!ready) source.failCapture(new Error('推文读取器启动超时，请重新加载页面。'));
  }, 5000);
  window.addEventListener(CAPTURE_READY_EVENT, () => {
    ready = true;
    window.clearTimeout(timeout);
    source.captureReady();
    console.debug('分享有据: 推文读取器已就绪', document.readyState);
  });

  const inject = (): void => {
    const root = document.head ?? document.documentElement;
    if (!root || script) return;
    observer?.disconnect();
    script = document.createElement('script');
    script.src = browser.runtime.getURL('/page/interceptor.js');
    script.async = false;
    const fail = (): void => {
      window.clearTimeout(timeout);
      source.failCapture(new Error('推文读取器未能启动，请重新加载页面。'));
      script?.remove();
    };
    script.addEventListener(
      'load',
      () => {
        script?.remove();
        if (!ready) fail();
      },
      { once: true },
    );
    script.addEventListener('error', fail, { once: true });
    root.append(script);
  };

  // At document_start even documentElement may not have been created yet.
  observer = new MutationObserver(inject);
  observer.observe(document, { childList: true, subtree: true });
  inject();
}
