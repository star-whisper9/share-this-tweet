import { normalizeTweetCandidate } from '../shared/tweet-normalizer.js';
import { mergeTweetRecords, type TweetRecord } from '../shared/model.js';

export const TWEET_DATA_EVENT = 'share-this-tweet:tweet-data';

interface Waiter {
  resolve: (record: TweetRecord) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class TweetSource {
  private readonly records = new Map<string, TweetRecord>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners = new Set<(record: TweetRecord) => void>();

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

    return new Promise<TweetRecord>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const waiters = this.waiters.get(tweetId) ?? [];
        this.waiters.set(
          tweetId,
          waiters.filter((waiter) => waiter.timer !== timer),
        );
        reject(new Error(`Timed out waiting for tweet ${tweetId}`));
      }, timeoutMs);
      const waiters = this.waiters.get(tweetId) ?? [];
      waiters.push({ resolve, reject, timer });
      this.waiters.set(tweetId, waiters);
    });
  }
}
