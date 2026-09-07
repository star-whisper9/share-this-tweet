import { ShareEnhancerController } from './ui.js';

function injectPageInterceptor(): void {
  const script = document.createElement('script');
  script.src = browser.runtime.getURL('/page/interceptor.js');
  script.async = false;
  script.addEventListener('load', () => script.remove(), { once: true });
  (document.head ?? document.documentElement).append(script);
}

if (location.hostname === 'x.com') {
  injectPageInterceptor();
  new ShareEnhancerController().start();
}
