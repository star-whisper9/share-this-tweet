import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTweetCapture } from '../src/content/capture.js';
import { TweetSource } from '../src/content/tweet-source.js';
import { CAPTURE_READY_EVENT, TWEET_DATA_EVENT } from '../src/shared/capture-protocol.js';

let mutation: () => void;
let script: EventTarget & { remove: ReturnType<typeof vi.fn> };
let root: { append: ReturnType<typeof vi.fn> };
let doc: {
  head: typeof root | null;
  documentElement: typeof root | null;
  createElement: () => typeof script;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  script = Object.assign(new EventTarget(), { remove: vi.fn() });
  root = { append: vi.fn() };
  doc = { head: null, documentElement: null, createElement: () => script };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('browser', {
    runtime: { getURL: (path: string) => `moz-extension://test${path}` },
  });
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const data = () =>
  new CustomEvent(TWEET_DATA_EVENT, {
    detail: JSON.stringify([
      { id_str: '42', full_text: 'hello', user: { id_str: '7', screen_name: 'alice' } },
    ]),
  });

describe('early capture startup', () => {
  it('waits for the document root, then captures data before script load and UI startup', async () => {
    const source = new TweetSource();
    startTweetCapture(source);
    expect(root.append).not.toHaveBeenCalled();
    root.append.mockImplementation(() => {
      window.dispatchEvent(new Event(CAPTURE_READY_EVENT));
      window.dispatchEvent(data());
    });
    doc.documentElement = root;
    mutation();
    mutation();
    script.dispatchEvent(new Event('load'));
    expect(root.append).toHaveBeenCalledOnce();
    await expect(source.waitFor('42')).resolves.toMatchObject({ text: 'hello' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'load'])(
    'reports script %s without a ready handshake as a startup failure',
    async (event) => {
      doc.documentElement = root;
      const source = new TweetSource();
      startTweetCapture(source);
      const waiting = expect(source.waitFor('42')).rejects.toThrow(Error);
      script.dispatchEvent(new Event(event));
      await waiting;
      await expect(source.waitFor('42')).rejects.toThrow(Error);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('times out startup and allows a late ready handshake and response to recover', async () => {
    const source = new TweetSource();
    startTweetCapture(source);
    const waiting = expect(source.waitFor('42', 10000)).rejects.toThrow(Error);
    await vi.advanceTimersByTimeAsync(5000);
    await waiting;
    window.dispatchEvent(new Event(CAPTURE_READY_EVENT));
    window.dispatchEvent(data());
    await expect(source.waitFor('42')).resolves.toMatchObject({ tweetId: '42' });
  });

  it('keeps target waiters independent and accepts data after a timeout', async () => {
    const source = new TweetSource();
    const timedOut = expect(source.waitFor('42', 10)).rejects.toThrow(Error);
    const other = source.waitFor('99', 1000);
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    const listener = vi.fn();
    source.subscribe(listener);
    window.addEventListener(TWEET_DATA_EVENT, (event) =>
      source.ingestSerialized((event as CustomEvent<string>).detail),
    );
    window.dispatchEvent(data());
    expect(listener).toHaveBeenCalledOnce();
    source.ingest([{ id_str: '99', text: 'other', user: { screen_name: 'bob' } }]);
    await expect(other).resolves.toMatchObject({ tweetId: '99' });
    await expect(source.waitFor('42')).resolves.toMatchObject({ tweetId: '42' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
