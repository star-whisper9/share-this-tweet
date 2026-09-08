import { CAPTURE_READY_EVENT, TWEET_DATA_EVENT } from '../shared/capture-protocol.js';
const MAX_NODES = 40000;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function getObject(value: unknown, key: string): JsonObject | undefined {
  return asObject(asObject(value)?.[key]);
}

function isTweetCandidate(value: JsonObject): boolean {
  if (value.__typename === 'Tweet' && typeof value.rest_id === 'string') return true;
  if (value.__typename === 'TweetWithVisibilityResults' && getObject(value, 'tweet')) return true;
  return (
    typeof value.id_str === 'string' &&
    (typeof value.full_text === 'string' || typeof value.text === 'string') &&
    (getObject(value, 'user') !== undefined || typeof value.user_id_str === 'string')
  );
}

function findTweetCandidates(payload: unknown): JsonObject[] {
  const result: JsonObject[] = [];
  const seen = new WeakSet<object>();
  let visited = 0;

  const visit = (value: unknown, depth: number): void => {
    if (visited >= MAX_NODES || depth > 24) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    const object = asObject(value);
    if (!object || seen.has(object)) return;
    seen.add(object);
    visited += 1;
    if (isTweetCandidate(object)) result.push(object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };

  visit(payload, 0);
  return result;
}

function postTweetData(payload: unknown): void {
  const candidates = findTweetCandidates(payload);
  if (candidates.length === 0) return;
  window.dispatchEvent(
    new CustomEvent(TWEET_DATA_EVENT, {
      detail: JSON.stringify(candidates),
      bubbles: false,
      cancelable: false,
    }),
  );
}

function processResponseText(text: string): void {
  postTweetData(JSON.parse(text));
}

function reportCaptureError(transport: string, error: unknown): void {
  // Do not log response bodies, URLs, or credentials from the host page.
  console.error('分享有据: 响应读取失败', transport, error instanceof Error ? error.name : 'Error');
}

function installInterceptor(): void {
  const installed = Symbol.for('share-this-tweet:interceptor-installed');
  const page = window as unknown as Record<symbol, unknown>;
  if (page[installed]) return;

  const observed = new WeakSet<XMLHttpRequest>();
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest['send']>) {
    // XHR instances can be reused. Install exactly one listener per instance.
    if (!observed.has(this)) {
      observed.add(this);
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (!this.getResponseHeader('Content-Type')?.toLowerCase().includes('json')) return;
          if (this.responseType === 'json') {
            postTweetData(this.response);
          } else if (this.responseType === '' || this.responseType === 'text') {
            processResponseText(this.responseText);
          }
        } catch (error) {
          reportCaptureError('XHR', error);
        }
      });
    }
    return originalSend.apply(this, args);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await originalFetch(...args);
    try {
      if (response.ok && response.headers.get('Content-Type')?.toLowerCase().includes('json')) {
        void response
          .clone()
          .text()
          .then(processResponseText)
          .catch((error: unknown) => {
            reportCaptureError('fetch', error);
          });
      }
    } catch (error) {
      reportCaptureError('fetch', error);
    }
    return response;
  };
  page[installed] = true;
}

try {
  installInterceptor();
  window.dispatchEvent(new Event(CAPTURE_READY_EVENT));
} catch (error) {
  reportCaptureError('install', error);
}
