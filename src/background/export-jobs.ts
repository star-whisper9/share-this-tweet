import { fileCacheDeadline, JOB_RETENTION } from '../shared/job-retention.js';
import { renderExportJob } from '../core/job-renderer.js';
import {
  deleteExportJob,
  getExportJob,
  getExportJobBlob,
  getExportJobDiagnostics,
  type JobPayloadChanges,
  listExportJobs,
  putExportJob,
  type StoredExportJob,
  type StoredExportJobFile,
} from '../core/job-store.js';
import { recordOutput, upsertTweetRecord } from '../core/storage.js';
import {
  isExportJobRequest,
  type ExportJobFile,
  type ExportJobRequest,
  type JobSummary,
} from '../shared/export-jobs.js';
import type { VideoDiagnosticsReport } from '../core/video-report.js';
import { getLocale, t, type Locale } from '../shared/i18n.js';

type ExportJobMessage =
  | { type: 'export-job-enqueue'; request: unknown }
  | { type: 'export-job-list' }
  | { type: 'export-job-cancel'; id: unknown }
  | { type: 'export-job-retry'; id: unknown }
  | { type: 'export-job-remove'; id: unknown }
  | { type: 'export-job-file'; id: unknown; fileId: unknown }
  | { type: 'export-job-diagnostics'; id: unknown }
  | { type: 'export-job-file-saved'; id: unknown; fileId: unknown }
  | { type: 'export-job-open' };

type JobResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const jobs = new Map<string, StoredExportJob>();
const controllers = new Map<string, AbortController>();
const activeDownloads = new Map<string, number>();
const pendingDownloads = new Map<
  number,
  {
    resolve: () => void;
    reject: (error: Error) => void;
    locale: Locale;
    signal: AbortSignal;
    abort: () => void;
  }
>();
let initialization: Promise<void> | undefined;
let processing = false;
let mutation = Promise.resolve();
const callbackWrites = new Map<string, Promise<void>>();
const pendingUpdates = new Map<
  string,
  {
    progress?: string;
    warnings: string[];
    diagnostics?: VideoDiagnosticsReport;
    scheduled: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }
>();
const CALLBACK_PERSIST_INTERVAL_MS = 500;

function messageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80;
}

function parseMessage(value: unknown): ExportJobMessage | undefined {
  if (!isObject(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'export-job-enqueue') return { type: value.type, request: value.request };
  if (value.type === 'export-job-list' || value.type === 'export-job-open')
    return { type: value.type };
  if (
    [
      'export-job-cancel',
      'export-job-retry',
      'export-job-remove',
      'export-job-diagnostics',
    ].includes(value.type)
  ) {
    return {
      type: value.type as Extract<ExportJobMessage, { id: unknown }>['type'],
      id: value.id,
    } as ExportJobMessage;
  }
  if (['export-job-file', 'export-job-file-saved'].includes(value.type)) {
    return {
      type: value.type as 'export-job-file' | 'export-job-file-saved',
      id: value.id,
      fileId: value.fileId,
    };
  }
  return undefined;
}

function toSummary(job: StoredExportJob): JobSummary {
  return {
    ...job.summary,
    warnings: [...job.summary.warnings],
    files: job.files.map((file) => ({
      id: file.id,
      filename: file.filename,
      size: file.size,
      saved: file.saved,
      cached: file.cached,
      cacheExpiresAt: file.cacheExpiresAt,
    })),
  };
}

function summaryFor(request: ExportJobRequest): JobSummary {
  return {
    id: request.id,
    kind: request.kind,
    tweetId: request.record.tweetId,
    author: request.record.author.name || request.record.author.handle,
    createdAt: new Date().toISOString(),
    status: 'queued',
    warnings: [],
    files: [],
    hasDiagnostics: false,
  };
}

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /\bAndroid\b/i.test(navigator.userAgent);
}

/** Serialize durable changes so progress, files, and cancellation never overwrite each other. */
function mutateJob(
  id: string,
  change: (job: StoredExportJob) => void | JobPayloadChanges | Promise<void | JobPayloadChanges>,
): Promise<StoredExportJob | undefined> {
  const operation = mutation.then(async () => {
    const current = jobs.get(id) ?? (await getExportJob(id));
    if (!current) return undefined;
    // Draft metadata only. Payload writes/deletions share the same transaction.
    const draft = structuredClone(current) as StoredExportJob;
    const payloads = (await change(draft)) ?? {};
    if (draft.summary.status !== current.summary.status) {
      draft.settledAt = ['queued', 'running'].includes(draft.summary.status)
        ? undefined
        : Date.now();
    }
    const retained = new Set(draft.files.filter((file) => file.cached).map((file) => file.id));
    payloads.removeFileIds = [
      ...new Set([
        ...(payloads.removeFileIds ?? []),
        ...current.files
          .filter((file) => file.cached && !retained.has(file.id))
          .map((file) => file.id),
      ]),
    ];
    draft.summary.files = toSummary(draft).files;
    await putExportJob(draft, payloads);
    jobs.set(id, draft);
    return draft;
  });
  mutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function scheduleProcessing(): void {
  queueMicrotask(() => {
    void processQueue().catch((error) => {
      // A store failure has already left the affected task in memory; do not
      // leak a rejected microtask from the persistent background script.
      console.error('分享有据: 导出队列失败', error);
    });
  });
}

export async function initializeExportJobs(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      const stored = await listExportJobs();
      for (const job of stored) jobs.set(job.id, job);
      for (const job of stored) {
        if (job.summary.status !== 'running') continue;
        await mutateJob(job.id, (current) => {
          current.summary.status = 'interrupted';
          current.summary.progress = undefined;
          current.summary.error = t('jobs.restartInterrupted', {}, current.request.locale);
        });
      }
      await sweepExpiredJobs(Date.now());
      const timer = setInterval(() => {
        void cleanupExportJobs().catch((error) =>
          console.error('Export cache cleanup failed', error),
        );
      }, JOB_RETENTION.sweepInterval);
      if (typeof timer === 'object') timer.unref();
      scheduleProcessing();
    })();
  }
  return initialization;
}

/** Excludes active/queued jobs; all deletions serialize with job mutations. */
async function sweepExpiredJobs(now: number): Promise<void> {
  const operation = mutation.then(async () => {
    for (const [id, current] of jobs) {
      if (controllers.has(id) || ['queued', 'running'].includes(current.summary.status)) continue;
      const settled = current.settledAt ?? Date.parse(current.summary.createdAt);
      if (
        !current.files.some((file) => file.cached && file.cacheExpiresAt <= now) &&
        !(current.summary.hasDiagnostics && (current.diagnosticsExpiresAt ?? 0) <= now) &&
        now < settled + JOB_RETENTION.history
      )
        continue;
      const job = structuredClone(current) as StoredExportJob;
      const changes: JobPayloadChanges = {};
      const expired = job.files.filter((file) => file.cached && file.cacheExpiresAt <= now);
      for (const file of expired) file.cached = false;
      changes.removeFileIds = expired.map((file) => file.id);
      if (job.summary.hasDiagnostics && (job.diagnosticsExpiresAt ?? 0) <= now) {
        job.summary.hasDiagnostics = false;
        job.diagnosticsExpiresAt = undefined;
        changes.diagnostics = null;
      }
      if (job.summary.status === 'ready' && job.files.some((file) => !file.saved && !file.cached)) {
        job.summary.status = 'expired';
      }
      const settledAt = job.settledAt ?? Date.parse(job.summary.createdAt);
      if (now >= settledAt + JOB_RETENTION.history && !job.files.some((file) => file.cached)) {
        await deleteExportJob(id);
        jobs.delete(id);
      } else if (
        expired.length ||
        changes.diagnostics === null ||
        job.summary.status !== current.summary.status
      ) {
        job.summary.files = toSummary(job).files;
        await putExportJob(job, changes);
        jobs.set(id, job);
      }
    }
  });
  mutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
export async function cleanupExportJobs(): Promise<void> {
  await initializeExportJobs();
  await sweepExpiredJobs(Date.now());
}

function findQueuedJob(): StoredExportJob | undefined {
  return Array.from(jobs.values())
    .filter((job) => job.summary.status === 'queued')
    .sort((left, right) => left.summary.createdAt.localeCompare(right.summary.createdAt))[0];
}

async function addWarning(id: string, warning: string): Promise<void> {
  await mutateJob(id, (job) => {
    if (!job.summary.warnings.includes(warning)) job.summary.warnings.push(warning);
  });
}

function queueCallbackWrite(id: string, operation: () => Promise<void>): void {
  const previous = callbackWrites.get(id) ?? Promise.resolve();
  const next = previous.then(operation);
  callbackWrites.set(id, next);
  void next.catch(async (error) => {
    controllers.get(id)?.abort();
    const job = jobs.get(id);
    if (!job || job.summary.status !== 'running') return;
    try {
      await mutateJob(id, (current) => {
        if (current.summary.status !== 'running') return;
        current.summary.status = 'failed';
        current.summary.progress = undefined;
        current.summary.error = messageError(error);
      });
    } catch {
      // If IndexedDB itself is unavailable, retain the visible in-memory
      // failure instead of letting a callback rejection disappear.
      job.summary.status = 'failed';
      job.summary.progress = undefined;
      job.summary.error = messageError(error);
    }
  });
}

/** Renderer callbacks are synchronous. Batch same-turn progress/diagnostics into one durable write. */
function receiveCallbackUpdate(
  id: string,
  update: { progress?: string; warning?: string; diagnostics?: VideoDiagnosticsReport },
): void {
  const pending = pendingUpdates.get(id) ?? { warnings: [], scheduled: false };
  if (update.progress !== undefined) pending.progress = update.progress;
  if (update.warning !== undefined) pending.warnings.push(update.warning);
  if (update.diagnostics !== undefined) pending.diagnostics = update.diagnostics;
  pendingUpdates.set(id, pending);
  if (pending.scheduled) return;
  pending.scheduled = true;
  pending.timer = setTimeout(() => commitCallbackUpdate(id), CALLBACK_PERSIST_INTERVAL_MS);
}

function commitCallbackUpdate(id: string): void {
  const scheduled = pendingUpdates.get(id);
  if (!scheduled) return;
  scheduled.scheduled = false;
  scheduled.timer = undefined;
  queueCallbackWrite(id, async () => {
    const latest = pendingUpdates.get(id);
    if (!latest) return;
    pendingUpdates.delete(id);
    await mutateJob(id, (job) => {
      if (job.summary.status === 'running') {
        if (latest.progress !== undefined) job.summary.progress = latest.progress;
        for (const warning of latest.warnings) {
          if (!job.summary.warnings.includes(warning)) job.summary.warnings.push(warning);
        }
      }
      // A dynamic renderer reports its final diagnostic record immediately
      // before rejecting. Keep it even if cancellation won the status race.
      if (latest.diagnostics) {
        job.diagnosticsExpiresAt = Date.now() + JOB_RETENTION.diagnostics;
        job.summary.hasDiagnostics = true;
        return { diagnostics: latest.diagnostics };
      }
    });
  });
}

async function flushCallbackUpdates(id: string): Promise<void> {
  const pending = pendingUpdates.get(id);
  if (pending?.timer !== undefined) clearTimeout(pending.timer);
  if (pending) commitCallbackUpdate(id);
  await callbackWrites.get(id);
  callbackWrites.delete(id);
}

async function storeHistory(job: StoredExportJob, file: StoredExportJobFile): Promise<void> {
  try {
    await upsertTweetRecord(job.request.record);
    await recordOutput(file.output);
  } catch (error) {
    await addWarning(
      job.id,
      t('jobs.savedWarning', { error: messageError(error) }, job.request.locale),
    );
  }
}

async function markFileSaved(id: string, fileId: string): Promise<StoredExportJob | undefined> {
  let savedFile: StoredExportJobFile | undefined;
  const job = await mutateJob(id, (current) => {
    const file = current.files.find((item) => item.id === fileId);
    if (!file) throw new Error(t('jobs.fileNotFound', {}, current.request.locale));
    if (!file.saved) {
      if (!file.cached) throw new Error(t('jobs.cacheReleased', {}, current.request.locale));
      file.saved = true;
      file.cacheExpiresAt = fileCacheDeadline(true, isAndroid(), Date.now());
      if (!isAndroid()) file.cached = false;
      savedFile = file;
    }
  });
  if (job && savedFile) await storeHistory(job, savedFile);
  return jobs.get(id);
}

function waitForDownload(downloadId: number, locale: Locale, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      pendingDownloads.delete(downloadId);
      reject(new DOMException(t('jobs.cancelled', {}, locale), 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    pendingDownloads.set(downloadId, { resolve, reject, locale, signal, abort });
    signal.addEventListener('abort', abort, { once: true });
    void browser.downloads
      .search({ id: downloadId })
      .then(([item]) => {
        if (!item) {
          settleDownload(downloadId, 'interrupted', t('jobs.noDownloadTask', {}, locale));
          return;
        }
        if (item.state === 'complete' || item.state === 'interrupted') {
          settleDownload(downloadId, item.state, item.error);
        }
      })
      .catch((error) => settleDownload(downloadId, 'interrupted', messageError(error)));
  });
}

function settleDownload(
  downloadId: number,
  state: 'complete' | 'interrupted',
  error?: string,
): void {
  const pending = pendingDownloads.get(downloadId);
  if (!pending) return;
  pendingDownloads.delete(downloadId);
  pending.signal.removeEventListener('abort', pending.abort);
  if (state === 'complete') pending.resolve();
  else
    pending.reject(
      new Error(t('jobs.downloadInterrupted', { error: error ?? '—' }, pending.locale)),
    );
}

browser.downloads?.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted')
    settleDownload(delta.id, state, delta.error?.current);
});

async function downloadDesktopFile(
  jobId: string,
  file: ExportJobFile,
  signal: AbortSignal,
  locale: Locale,
): Promise<void> {
  const objectUrl = URL.createObjectURL(file.blob);
  try {
    const downloadId = await browser.downloads.download({
      url: objectUrl,
      filename: file.filename,
      saveAs: false,
    });
    activeDownloads.set(jobId, downloadId);
    if (signal.aborted) {
      await browser.downloads.cancel(downloadId);
      signal.throwIfAborted();
    }
    await waitForDownload(downloadId, locale, signal);
  } finally {
    activeDownloads.delete(jobId);
    URL.revokeObjectURL(objectUrl);
  }
}

async function acceptFile(jobId: string, file: ExportJobFile): Promise<void> {
  const locale = jobs.get(jobId)?.request.locale ?? getLocale();
  if (!(file.blob instanceof Blob) || !file.blob.size || !isId(file.id) || !file.filename) {
    throw new Error(t('jobs.invalidFile', {}, locale));
  }
  await mutateJob(jobId, (job) => {
    const existing = job.files.find((item) => item.id === file.id);
    // A retry renders all selections again. An output already saved by a
    // previous partial attempt is deliberately skipped to avoid duplicates.
    if (existing?.saved) return;
    const { blob, ...metadata } = file;
    const stored: StoredExportJobFile = {
      ...metadata,
      size: blob.size,
      saved: false,
      cached: true,
      cacheExpiresAt: fileCacheDeadline(false, isAndroid(), Date.now()),
    };
    if (existing) Object.assign(existing, stored);
    else job.files.push(stored);
    return { files: [{ id: file.id, blob }] };
  });
  const controller = controllers.get(jobId);
  if (!controller || jobs.get(jobId)?.summary.status !== 'running')
    throw new DOMException(t('jobs.cancelled', {}, locale), 'AbortError');
  controller.signal.throwIfAborted();
  if (jobs.get(jobId)?.files.find((item) => item.id === file.id)?.saved) return;
  if (!isAndroid()) {
    await downloadDesktopFile(jobId, file, controller.signal, locale);
    await markFileSaved(jobId, file.id);
  }
}

async function processJob(job: StoredExportJob): Promise<void> {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  try {
    const started = await mutateJob(job.id, (current) => {
      if (current.summary.status !== 'queued') return;
      current.summary.status = 'running';
      current.summary.error = undefined;
    });
    if (!started || started.summary.status !== 'running') return;
    await renderExportJob(job.request, {
      signal: controller.signal,
      onProgress: (progress: string) => receiveCallbackUpdate(job.id, { progress }),
      onWarning: (warning: string) => receiveCallbackUpdate(job.id, { warning }),
      onDiagnostics: (diagnostics: VideoDiagnosticsReport) =>
        receiveCallbackUpdate(job.id, { diagnostics }),
      onFile: async (file: ExportJobFile) => acceptFile(job.id, file),
    });
    await flushCallbackUpdates(job.id);
    await mutateJob(job.id, (current) => {
      if (current.summary.status !== 'running') return;
      current.summary.progress = undefined;
      current.summary.status =
        isAndroid() && current.files.some((file) => !file.saved) ? 'ready' : 'completed';
    });
  } catch (renderError) {
    let error = renderError;
    let callbackWriteFailed = false;
    try {
      await flushCallbackUpdates(job.id);
    } catch (flushError) {
      error = flushError;
      callbackWriteFailed = true;
    }
    const current = jobs.get(job.id);
    // A failed callback write already marks a task failed and aborts its
    // renderer. Do not re-label that storage failure as user cancellation.
    if (current?.summary.status === 'cancelled' || current?.summary.status === 'failed') return;
    const status = callbackWriteFailed || !controller.signal.aborted ? 'failed' : 'cancelled';
    try {
      await mutateJob(job.id, (updated) => {
        if (updated.summary.status === 'cancelled' || updated.summary.status === 'failed') return;
        updated.summary.status = status;
        updated.summary.progress = undefined;
        updated.summary.error = messageError(error);
      });
    } catch {
      // Continue with later queued work even when the task store itself has
      // failed. The active in-memory task remains inspectable in this session.
      const active = jobs.get(job.id);
      if (active && active.summary.status !== 'cancelled' && active.summary.status !== 'failed') {
        active.summary.status = status;
        active.summary.progress = undefined;
        active.summary.error = messageError(error);
      }
    }
  } finally {
    controllers.delete(job.id);
    const pending = pendingUpdates.get(job.id);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    pendingUpdates.delete(job.id);
    callbackWrites.delete(job.id);
  }
}

async function processQueue(): Promise<void> {
  await initializeExportJobs();
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const next = findQueuedJob();
      if (!next) return;
      await processJob(next);
    }
  } finally {
    processing = false;
  }
}

async function enqueue(request: ExportJobRequest): Promise<JobResponse> {
  await cleanupExportJobs();
  const existing = jobs.get(request.id) ?? (await getExportJob(request.id));
  if (existing && JSON.stringify(existing.request) === JSON.stringify(request)) {
    jobs.set(existing.id, existing);
    return { ok: true, id: existing.id };
  }
  if (existing) {
    return { ok: false, error: t('jobs.taskExists', {}, request.locale) };
  }
  const job: StoredExportJob = { id: request.id, request, summary: summaryFor(request), files: [] };
  await putExportJob(job);
  jobs.set(job.id, job);
  if (isAndroid()) {
    try {
      await open();
    } catch (error) {
      jobs.delete(job.id);
      await deleteExportJob(job.id);
      return { ok: false, error: messageError(error) };
    }
  }
  scheduleProcessing();
  return { ok: true, id: job.id };
}

async function cancel(id: string): Promise<JobResponse> {
  await initializeExportJobs();
  const job = jobs.get(id);
  if (!job) return { ok: false, error: t('jobs.notFound', {}, getLocale()) };
  if (job.summary.status === 'completed')
    return { ok: false, error: t('jobs.completedCannotCancel', {}, job.request.locale) };
  const controller = controllers.get(id);
  controller?.abort();
  const downloadId = activeDownloads.get(id);
  if (downloadId !== undefined) {
    try {
      await browser.downloads.cancel(downloadId);
    } catch (error) {
      await addWarning(
        id,
        t('jobs.downloadFailed', { error: messageError(error) }, job.request.locale),
      );
    }
  }
  await mutateJob(id, (current) => {
    current.summary.status = 'cancelled';
    current.summary.progress = undefined;
  });
  return { ok: true };
}

async function retry(id: string): Promise<JobResponse> {
  await initializeExportJobs();
  const job = jobs.get(id);
  if (!job) return { ok: false, error: t('jobs.notFound', {}, getLocale()) };
  if (controllers.has(id)) return { ok: false, error: t('jobs.busy', {}, job.request.locale) };
  if (!['failed', 'cancelled', 'interrupted', 'expired'].includes(job.summary.status)) {
    return { ok: false, error: t('jobs.retryUnavailable', {}, job.request.locale) };
  }
  const updated = await mutateJob(id, (current) => {
    if (
      controllers.has(id) ||
      !['failed', 'cancelled', 'interrupted', 'expired'].includes(current.summary.status)
    )
      throw new Error(t('jobs.busy', {}, current.request.locale));
    current.files = current.files.filter((file) => file.saved);
    current.diagnosticsExpiresAt = undefined;
    current.summary.hasDiagnostics = false;
    current.summary.status = 'queued';
    current.summary.progress = undefined;
    current.summary.error = undefined;
    return { diagnostics: null };
  });
  if (!updated) return { ok: false, error: t('jobs.notFound', {}, job.request.locale) };
  scheduleProcessing();
  return { ok: true };
}

async function remove(id: string): Promise<JobResponse> {
  await initializeExportJobs();
  const job = jobs.get(id);
  if (!job) return { ok: false, error: t('jobs.notFound', {}, getLocale()) };
  if (controllers.has(id) || job.summary.status === 'queued' || job.summary.status === 'running') {
    return { ok: false, error: t('jobs.busy', {}, job.request.locale) };
  }
  const operation = mutation.then(async () => {
    const current = jobs.get(id);
    if (current && (controllers.has(id) || ['queued', 'running'].includes(current.summary.status)))
      throw new Error(t('jobs.busy', {}, current.request.locale));
    await deleteExportJob(id);
    jobs.delete(id);
  });
  mutation = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
  return { ok: true };
}

async function file(id: string, fileId: string): Promise<JobResponse> {
  await initializeExportJobs();
  const job = jobs.get(id);
  const output = job?.files.find((item) => item.id === fileId);
  if (!output)
    return { ok: false, error: t('jobs.fileNotFound', {}, job?.request.locale ?? getLocale()) };
  if (!output.cached || (!controllers.has(id) && output.cacheExpiresAt <= Date.now())) {
    await cleanupExportJobs();
    return { ok: false, error: t('jobs.cacheReleased', {}, job!.request.locale) };
  }
  const blob = await getExportJobBlob(output.id);
  if (!blob) return { ok: false, error: t('jobs.fileNotFound', {}, job!.request.locale) };
  return { ok: true, blob, filename: output.filename };
}

async function diagnostics(id: string): Promise<JobResponse> {
  await initializeExportJobs();
  const job = jobs.get(id);
  const report =
    job?.summary.hasDiagnostics &&
    (controllers.has(id) || (job.diagnosticsExpiresAt ?? 0) > Date.now())
      ? await getExportJobDiagnostics(id)
      : undefined;
  if (!report)
    return {
      ok: false,
      error: t('jobs.diagnosticsNotFound', {}, job?.request.locale ?? getLocale()),
    };
  return { ok: true, diagnostics: report };
}

async function fileSaved(id: string, fileId: string): Promise<JobResponse> {
  await cleanupExportJobs();
  const job = jobs.get(id);
  if (!job) return { ok: false, error: t('jobs.notFound', {}, getLocale()) };
  if (!isAndroid())
    return { ok: false, error: t('jobs.androidManualSaveOnly', {}, job.request.locale) };
  try {
    const updated = await markFileSaved(id, fileId);
    if (!updated) return { ok: false, error: t('jobs.notFound', {}, job.request.locale) };
    await mutateJob(id, (current) => {
      if (current.summary.status === 'ready' && current.files.every((item) => item.saved)) {
        current.summary.status = 'completed';
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: messageError(error) };
  }
}

async function open(): Promise<JobResponse> {
  const url = browser.runtime.getURL('tasks/tasks.html');
  const tabs = await browser.tabs.query({ url });
  const existing = tabs[0];
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined)
      await browser.windows?.update(existing.windowId, { focused: true });
  } else await browser.tabs.create({ url, active: true });
  return { ok: true };
}

/** Handle only job protocol messages; background.ts keeps all existing messages unchanged. */
export function handleExportJobMessage(message: unknown): Promise<unknown> | undefined {
  const parsed = parseMessage(message);
  if (!parsed) return undefined;
  if (parsed.type === 'export-job-enqueue') {
    if (!isExportJobRequest(parsed.request))
      return Promise.resolve({ ok: false, error: t('jobs.invalidRequest') });
    return enqueue(parsed.request).catch((error) => ({ ok: false, error: messageError(error) }));
  }
  if (parsed.type === 'export-job-list')
    return cleanupExportJobs()
      .then(() => ({ ok: true, jobs: Array.from(jobs.values()).map(toSummary) }))
      .catch((error) => ({ ok: false, error: messageError(error) }));
  if (parsed.type === 'export-job-open')
    return open().catch((error) => ({ ok: false, error: messageError(error) }));
  if (!isId(parsed.id)) return Promise.resolve({ ok: false, error: t('jobs.invalidTaskId') });
  if (parsed.type === 'export-job-cancel')
    return cancel(parsed.id).catch((error) => ({ ok: false, error: messageError(error) }));
  if (parsed.type === 'export-job-retry')
    return retry(parsed.id).catch((error) => ({ ok: false, error: messageError(error) }));
  if (parsed.type === 'export-job-remove')
    return remove(parsed.id).catch((error) => ({ ok: false, error: messageError(error) }));
  if (parsed.type === 'export-job-diagnostics')
    return diagnostics(parsed.id).catch((error) => ({ ok: false, error: messageError(error) }));
  if (!isId(parsed.fileId)) return Promise.resolve({ ok: false, error: t('jobs.invalidFileId') });
  if (parsed.type === 'export-job-file')
    return file(parsed.id, parsed.fileId).catch((error) => ({
      ok: false,
      error: messageError(error),
    }));
  return fileSaved(parsed.id, parsed.fileId).catch((error) => ({
    ok: false,
    error: messageError(error),
  }));
}
