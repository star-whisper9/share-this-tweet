import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_READY_EVENT,
  TWEET_DATA_EVENT,
  TRANSLATION_DATA_EVENT,
} from '../src/shared/capture-protocol.js';

const candidate = { __typename: 'Tweet', rest_id: '42', legacy: { full_text: 'test' } };

class FakeXHR extends EventTarget {
  status = 200;
  responseType = '';
  response: unknown = candidate;
  body = JSON.stringify({ data: candidate });
  contentType = 'application/json';
  get responseText(): string {
    if (!['', 'text'].includes(this.responseType)) throw new Error('InvalidStateError');
    return this.body;
  }
  getResponseHeader(): string {
    return this.contentType;
  }
  open(): void {}
  send(): void {
    this.dispatchEvent(new Event('load'));
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { fetch: vi.fn() }));
  // A fresh prototype is needed because installation wraps send.
  class XHR extends FakeXHR {}
  vi.stubGlobal('XMLHttpRequest', XHR);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function collect(): unknown[] {
  const records: unknown[] = [];
  window.addEventListener(TWEET_DATA_EVENT, (event) => {
    records.push(JSON.parse((event as CustomEvent<string>).detail));
  });
  return records;
}

describe('page response capture', () => {
  it('captures text and parsed JSON XHR responses, including reused instances', async () => {
    const records = collect();
    const ready = vi.fn();
    window.addEventListener(CAPTURE_READY_EVENT, ready);
    await import('../src/page/interceptor.js');
    const xhr = new XMLHttpRequest();
    xhr.send();
    xhr.responseType = 'json';
    xhr.send();
    expect(records).toEqual([[candidate], [candidate]]);
    expect(ready).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('does not wrap again when the page script is loaded twice', async () => {
    const records = collect();
    await import('../src/page/interceptor.js');
    const send = XMLHttpRequest.prototype.send;
    const fetch = window.fetch;
    vi.resetModules();
    await import('../src/page/interceptor.js');
    expect(XMLHttpRequest.prototype.send).toBe(send);
    expect(window.fetch).toBe(fetch);
    new XMLHttpRequest().send();
    expect(records).toHaveLength(1);
  });

  it('ignores binary and unsuccessful responses and reports malformed JSON without throwing', async () => {
    const records = collect();
    await import('../src/page/interceptor.js');
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.responseType = 'arraybuffer';
    xhr.send();
    xhr.responseType = '';
    xhr.status = 403;
    xhr.send();
    xhr.status = 200;
    xhr.body = '{broken';
    expect(() => xhr.send()).not.toThrow();
    expect(records).toEqual([]);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('returns the original fetch response and reads only its clone', async () => {
    const records = collect();
    const response = new Response(JSON.stringify(candidate), {
      headers: { 'Content-Type': 'application/json' },
    });
    const original = vi.mocked(window.fetch).mockResolvedValue(response);
    await import('../src/page/interceptor.js');
    expect(await window.fetch('/test')).toBe(response);
    await vi.waitFor(() => expect(records).toEqual([[candidate]]));
    expect(response.bodyUsed).toBe(false);
    expect(original).toHaveBeenCalledWith('/test');
  });

  it('preserves fetch rejection and exposes clone failure without failing the page request', async () => {
    const original = vi.mocked(window.fetch);
    const networkError = new Error('network');
    original.mockRejectedValueOnce(networkError);
    await import('../src/page/interceptor.js');
    await expect(window.fetch('/test')).rejects.toBe(networkError);
    const response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    vi.spyOn(response, 'clone').mockImplementation(() => {
      throw new Error('clone failed');
    });
    original.mockResolvedValue(response);
    expect(await window.fetch('/test')).toBe(response);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('reports asynchronous clone read failures without rejecting the page fetch', async () => {
    const response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    vi.spyOn(response, 'clone').mockReturnValue({
      text: () => Promise.reject(new Error('read failed')),
    } as Response);
    vi.mocked(window.fetch).mockResolvedValue(response);
    await import('../src/page/interceptor.js');
    expect(await window.fetch('/test')).toBe(response);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
  });
});

it('captures manual translation text streams with their request identity over XHR', async () => {
  const events: Array<Record<string, unknown>> = [];
  window.addEventListener(TRANSLATION_DATA_EVENT, (event) =>
    events.push(JSON.parse((event as CustomEvent<string>).detail)),
  );
  await import('../src/page/interceptor.js');
  const xhr = new XMLHttpRequest() as unknown as FakeXHR;
  xhr.body =
    '{"result":{"content_type":"POST","text":"早上"}}{"result":{"content_type":"POST","text":"好！"}}';
  xhr.contentType = 'text/plain';
  const real = xhr as unknown as XMLHttpRequest;
  real.open('POST', 'https://api.x.com/2/grok/translation.json');
  real.send(JSON.stringify({ content_type: 'POST', id: '42', dst_lang: 'zh' }));
  expect(events.map((event) => event.phase)).toEqual(['start', 'complete']);
  expect(events[1]).toMatchObject({
    tweetId: '42',
    targetLanguage: 'zh',
    text: '早上好！',
    requestId: events[0].requestId,
  });
});
it('captures fetch translation streams without changing the returned response', async () => {
  const events: Array<Record<string, unknown>> = [];
  window.addEventListener(TRANSLATION_DATA_EVENT, (event) =>
    events.push(JSON.parse((event as CustomEvent<string>).detail)),
  );
  const response = new Response('{"result":{"content_type":"POST","text":"translated"}}', {
    headers: { 'Content-Type': 'text/plain' },
  });
  vi.mocked(window.fetch).mockResolvedValue(response);
  await import('../src/page/interceptor.js');
  expect(
    await window.fetch('https://api.x.com/2/grok/translation.json', {
      method: 'POST',
      body: JSON.stringify({ content_type: 'POST', id: '42', dst_lang: 'zh' }),
    }),
  ).toBe(response);
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(events[1].text).toBe('translated');
  expect(await response.text()).toContain('translated');
});
