const TWEET_DATA_EVENT = 'share-this-tweet:tweet-data';
const MAX_NODES = 40000;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function getObject(value: unknown, key: string): JsonObject | undefined {
  return asObject(asObject(value)?.[key]);
}

function isTweetCandidate(value: JsonObject): boolean {
  if (value.__typename === 'Tweet' && typeof value.rest_id === 'string') return true;
  if (value.__typename === 'TweetWithVisibilityResults' && getObject(value, 'tweet')) return true;
  return typeof value.id_str === 'string'
    && (typeof value.full_text === 'string' || typeof value.text === 'string')
    && (getObject(value, 'user') !== undefined || typeof value.user_id_str === 'string');
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
  window.dispatchEvent(new CustomEvent(TWEET_DATA_EVENT, {
    detail: JSON.stringify(candidates),
    bubbles: false,
    cancelable: false
  }));
}

function processResponseText(text: string): void {
  try {
    postTweetData(JSON.parse(text));
  } catch {
    // Most X responses are not JSON. Ignore those responses by design.
  }
}

const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest['send']>) {
  this.addEventListener('readystatechange', () => {
    if (this.readyState !== XMLHttpRequest.DONE || this.status < 200 || this.status >= 300) return;
    if (!this.getResponseHeader('Content-Type')?.includes('json')) return;
    if (typeof this.responseText === 'string') processResponseText(this.responseText);
  });
  return originalSend.apply(this, args);
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const response = await originalFetch(...args);
  if (response.headers.get('Content-Type')?.includes('json')) {
    void response.clone().text().then(processResponseText);
  }
  return response;
};
