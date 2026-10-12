import type { VideoDiagnosticsReport } from '../core/video-report.js';

export interface JobCallbackUpdate {
  progress?: string;
  warning?: string;
  diagnostics?: VideoDiagnosticsReport;
}
export interface BufferedJobUpdate {
  progress?: string;
  warnings: string[];
  diagnostics?: VideoDiagnosticsReport;
}
interface PendingUpdate extends BufferedJobUpdate {
  scheduled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Batch synchronous renderer callbacks; all durable state changes remain with the queue. */
export class JobUpdateBuffer {
  private readonly pending = new Map<string, PendingUpdate>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(
    private readonly persist: (id: string, update: BufferedJobUpdate) => Promise<void>,
    private readonly onFailure: (id: string, error: unknown) => Promise<void>,
  ) {}

  receive(id: string, update: JobCallbackUpdate): void {
    const pending = this.pending.get(id) ?? { warnings: [], scheduled: false };
    if (update.progress !== undefined) pending.progress = update.progress;
    if (update.warning !== undefined) pending.warnings.push(update.warning);
    if (update.diagnostics !== undefined) pending.diagnostics = update.diagnostics;
    this.pending.set(id, pending);
    if (pending.scheduled) return;
    pending.scheduled = true;
    pending.timer = setTimeout(() => this.commit(id), 500);
  }

  private commit(id: string): void {
    const scheduled = this.pending.get(id);
    if (!scheduled) return;
    scheduled.scheduled = false;
    scheduled.timer = undefined;
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const update = this.pending.get(id);
      if (!update) return;
      this.pending.delete(id);
      await this.persist(id, update);
    });
    this.writes.set(id, next);
    void next.catch((error: unknown) => this.onFailure(id, error));
  }

  async flush(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    if (pending) this.commit(id);
    await this.writes.get(id);
    this.writes.delete(id);
  }

  dispose(id: string): void {
    const pending = this.pending.get(id);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(id);
    this.writes.delete(id);
  }
}
