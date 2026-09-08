import { ShareEnhancerController } from './ui.js';
import { TweetSource } from './tweet-source.js';
import { startTweetCapture } from './capture.js';

if (location.hostname === 'x.com') {
  const tweetSource = new TweetSource();
  startTweetCapture(tweetSource);
  const startUI = (): void => new ShareEnhancerController(tweetSource).start();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUI, { once: true });
  } else {
    startUI();
  }
}
