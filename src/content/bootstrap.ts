import { ShareEnhancerController } from './ui.js';
import { TWEET_DATA_EVENT, TweetSource } from './tweet-source.js';

const tweetSource = new TweetSource();

window.addEventListener(TWEET_DATA_EVENT, (event) => {
  const detail = (event as CustomEvent<string>).detail;
  if (typeof detail !== 'string') return;
  try {
    tweetSource.ingestSerialized(detail);
  } catch (error) {
    console.error('Share This Tweet: failed to ingest tweet data', error);
  }
});

function injectPageInterceptor(): void {
  const script = document.createElement('script');
  script.src = browser.runtime.getURL('/page/interceptor.js');
  script.async = false;
  script.addEventListener('load', () => script.remove(), { once: true });
  (document.head ?? document.documentElement).append(script);
}

if (location.hostname === 'x.com') {
  injectPageInterceptor();
  new ShareEnhancerController(tweetSource).start();
}
