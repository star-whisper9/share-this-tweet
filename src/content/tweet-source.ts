import {
  normalizeTranslation,
  mergeTranslation,
  type TweetTranslation,
} from '../shared/translation.js';
import { normalizeTweetCandidate } from '../shared/tweet-normalizer.js';
import { mergeTweetRecords, withoutQuote, type TweetRecord } from '../shared/model.js';

interface Waiter {
  resolve: (record: TweetRecord) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class TweetSource {
  private captureError?: Error;
  private readonly translationRequests = new Map<
    number,
    { tweetId: string; targetLanguage: string; originalText?: string; language?: string }
  >();
  private readonly latestTranslations = new Map<string, number>();
  private readonly translationUpdates = new Map<
    string,
    { text?: string; targetLanguage: string; originalText?: string; language?: string }
  >();

  ingestTranslation(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    if (
      typeof event.requestId !== 'number' ||
      !Number.isSafeInteger(event.requestId) ||
      typeof event.tweetId !== 'string' ||
      !/^\d+$/.test(event.tweetId) ||
      typeof event.targetLanguage !== 'string' ||
      !event.targetLanguage.trim() ||
      event.targetLanguage.length > 100
    )
      return;
    if (event.phase === 'start') {
      const record =
        this.records.get(event.tweetId) ??
        Array.from(this.records.values()).find((item) => item.quote?.tweetId === event.tweetId)
          ?.quote?.record;
      this.translationRequests.set(event.requestId, {
        tweetId: event.tweetId,
        targetLanguage: event.targetLanguage,
        originalText: record?.text,
        language: record?.language,
      });
      this.latestTranslations.delete(event.tweetId);
      this.latestTranslations.set(event.tweetId, event.requestId);
      while (this.translationRequests.size > 32)
        this.translationRequests.delete(this.translationRequests.keys().next().value!);
      while (this.latestTranslations.size > 32)
        this.latestTranslations.delete(this.latestTranslations.keys().next().value!);
      return;
    }
    if (event.phase !== 'complete') return;
    const request = this.translationRequests.get(event.requestId);
    this.translationRequests.delete(event.requestId);
    if (
      !request ||
      request.tweetId !== event.tweetId ||
      request.targetLanguage !== event.targetLanguage ||
      this.latestTranslations.get(event.tweetId) !== event.requestId
    )
      return;
    const text =
      typeof event.text === 'string' && event.text.length <= 100000 ? event.text : undefined;
    this.translationUpdates.delete(event.tweetId);
    this.translationUpdates.set(event.tweetId, { ...request, text });
    while (this.translationUpdates.size > 32)
      this.translationUpdates.delete(this.translationUpdates.keys().next().value!);
    this.ingest([]);
  }

  private translatedRecord(record: TweetRecord): TweetRecord {
    const update = this.translationUpdates.get(record.tweetId);
    if (!update) return record;
    // A response can precede the first core record; bind it once rather than synthesizing a tweet.
    update.originalText ??= record.text;
    update.language ??= record.language;
    const translation: TweetTranslation | undefined = mergeTranslation(
      normalizeTranslation(
        {
          is_available: true,
          data: {
            translation: update.text,
            source_language: update.language,
            destination_language: update.targetLanguage,
          },
        },
        update.originalText,
        update.language,
      ),
      undefined,
      record.text,
    );
    return JSON.stringify(translation) === JSON.stringify(record.translation)
      ? record
      : { ...record, translation };
  }

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
    const changed = new Set<string>();
    const candidates = Array.isArray(payload) ? payload : [payload];
    for (const candidate of candidates) {
      const record = normalizeTweetCandidate(candidate);
      if (!record) continue;
      const existing = this.records.get(record.tweetId);
      const merged = existing ? mergeTweetRecords(existing, record) : record;
      this.records.set(record.tweetId, merged);
      changed.add(record.tweetId);
    }
    // Resolve references after collecting the whole response, independent of candidate order.
    for (const [id, record] of this.records) {
      const quote = record.quote;
      const target = quote?.tweetId ? this.records.get(quote.tweetId) : undefined;
      if (
        quote &&
        target &&
        target.tweetId !== id &&
        quote.status !== 'unavailable' &&
        (changed.has(id) || changed.has(target.tweetId))
      ) {
        changed.add(id);
        this.records.set(
          id,
          mergeTweetRecords(record, {
            ...record,
            quote: {
              tweetId: target.tweetId,
              url: target.url,
              status: 'available',
              record: withoutQuote(target),
            },
          }),
        );
      }
    }
    // Apply manual results after quote hydration so an older embedded snapshot cannot undo them.
    for (const [id, original] of this.records) {
      let record = this.translatedRecord(original);
      if (record.quote?.record) {
        const quoted = this.translatedRecord(record.quote.record);
        if (quoted !== record.quote.record)
          record = { ...record, quote: { ...record.quote, record: withoutQuote(quoted) } };
      }
      if (record !== original) {
        this.records.set(id, record);
        changed.add(id);
      }
    }
    for (const id of changed) {
      const merged = this.records.get(id)!;
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
