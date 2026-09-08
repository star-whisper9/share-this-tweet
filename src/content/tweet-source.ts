import { normalizeTweetCandidate } from '../shared/tweet-normalizer.js';
import { mergeTweetRecords, type TweetRecord } from '../shared/model.js';

interface Waiter {
  resolve: (record: TweetRecord) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class TweetSource {
  private captureError?: Error;
  private readonly records = new Map<string, TweetRecord>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners = new Set<(record: TweetRecord) => void>();

  captureReady(): void {
    this.captureError = undefined;
  }

  failCapture(error: Error): void {
    this.captureError = error;
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    console.error('分享有据: 推文读取器启动失败', error.message);
  }

  subscribe(listener: (record: TweetRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(tweetId: string): TweetRecord | undefined {
    return this.records.get(tweetId);
  }

  ingestSerialized(serialized: string): void {
    const payload: unknown = JSON.parse(serialized);
    this.ingest(payload);
  }

  ingest(payload: unknown): void {
    const candidates = Array.isArray(payload) ? payload : [payload];
    for (const candidate of candidates) {
      const record = normalizeTweetCandidate(candidate);
      if (!record) continue;
      const existing = this.records.get(record.tweetId);
      const merged = existing ? mergeTweetRecords(existing, record) : record;
      this.records.set(record.tweetId, merged);
      for (const listener of this.listeners) listener(merged);
      const waiters = this.waiters.get(merged.tweetId);
      if (!waiters) continue;
      this.waiters.delete(merged.tweetId);
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timer);
        waiter.resolve(merged);
      }
    }
  }

  waitFor(tweetId: string, timeoutMs = 5000): Promise<TweetRecord> {
    const existing = this.get(tweetId);
    if (existing) return Promise.resolve(existing);
    if (this.captureError) return Promise.reject(this.captureError);

    return new Promise<TweetRecord>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const waiters = this.waiters.get(tweetId) ?? [];
        const remaining = waiters.filter((waiter) => waiter.timer !== timer);
        if (remaining.length > 0) this.waiters.set(tweetId, remaining);
        else this.waiters.delete(tweetId);
        reject(new Error('尚未收到当前推文数据，请重新加载页面后重试。'));
      }, timeoutMs);
      const waiters = this.waiters.get(tweetId) ?? [];
      waiters.push({ resolve, reject, timer });
      this.waiters.set(tweetId, waiters);
    });
  }
}
