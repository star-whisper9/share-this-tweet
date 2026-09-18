import type { VideoDiagnosticsReport } from './video-report.js';
import { fileCacheDeadline, JOB_RETENTION } from '../shared/job-retention.js';
import type { ExportJobFile, ExportJobRequest, JobSummary } from '../shared/export-jobs.js';

export const EXPORT_JOBS_DATABASE_NAME = 'share-this-tweet.export-jobs';
export const EXPORT_JOBS_DATABASE_VERSION = 2;
export const EXPORT_JOBS_STORE = 'jobs';

const FILES_STORE = 'files';
const DIAGNOSTICS_STORE = 'diagnostics';
const ALL_STORES = [EXPORT_JOBS_STORE, FILES_STORE, DIAGNOSTICS_STORE];

export interface StoredExportJobFile extends Omit<ExportJobFile, 'blob'> {
  size: number;
  saved: boolean;
  cached: boolean;
  cacheExpiresAt: number;
}

/** Metadata only: large payloads are loaded separately, never by queue listing. */
export interface StoredExportJob {
  id: string;
  request: ExportJobRequest;
  summary: JobSummary;
  files: StoredExportJobFile[];
  settledAt?: number;
  diagnosticsExpiresAt?: number;
}
export interface JobPayloadChanges {
  files?: Array<{ id: string; blob: Blob }>;
  removeFileIds?: string[];
  diagnostics?: VideoDiagnosticsReport | null;
}

export class ExportJobStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExportJobStoreError';
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openExportJobsDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new ExportJobStoreError('IndexedDB is unavailable for export tasks'));
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(EXPORT_JOBS_DATABASE_NAME, EXPORT_JOBS_DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const store = database.objectStoreNames.contains(EXPORT_JOBS_STORE)
        ? request.transaction!.objectStore(EXPORT_JOBS_STORE)
        : database.createObjectStore(EXPORT_JOBS_STORE, { keyPath: 'id' });
      if (!store.indexNames.contains('createdAt'))
        store.createIndex('createdAt', 'summary.createdAt');
      if (!store.indexNames.contains('status')) store.createIndex('status', 'summary.status');
      const files = database.createObjectStore(FILES_STORE, { keyPath: 'id' });
      files.createIndex('jobId', 'jobId');
      const diagnostics = database.createObjectStore(DIAGNOSTICS_STORE, { keyPath: 'id' });
      if (event.oldVersion === 1) {
        // Move one legacy task at a time, within the upgrade transaction. On
        // failure IndexedDB rolls back both schema and data; never drop Blobs.
        const now = Date.now();
        const android =
          typeof navigator !== 'undefined' && /\bAndroid\b/i.test(navigator.userAgent);
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          const old = item.value as StoredExportJob & {
            diagnostics?: VideoDiagnosticsReport;
            files: Array<StoredExportJobFile & { blob?: Blob }>;
          };
          for (const file of old.files) {
            const blob = file.blob;
            file.size = blob?.size ?? file.size ?? 0;
            file.cacheExpiresAt = fileCacheDeadline(file.saved, android, now);
            file.cached = !!blob && file.cacheExpiresAt > now;
            if (file.cached) files.put({ id: file.id, jobId: old.id, blob });
            delete file.blob;
          }
          if (old.diagnostics) {
            diagnostics.put({ id: old.id, report: old.diagnostics });
            old.diagnosticsExpiresAt = now + JOB_RETENTION.diagnostics;
            delete old.diagnostics;
          }
          // Give existing tasks a full retention window on upgrade.
          if (!['queued', 'running'].includes(old.summary.status)) old.settledAt = now;
          old.summary.files = old.files.map(
            ({ id, filename, size, saved, cached, cacheExpiresAt }) => ({
              id,
              filename,
              size,
              saved,
              cached,
              cacheExpiresAt,
            }),
          );
          item.update(old);
          item.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new ExportJobStoreError('Could not open export task storage', { cause: request.error }),
      );
    request.onblocked = () => reject(new ExportJobStoreError('Export task storage is blocked'));
  });
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openExportJobsDatabase();
  try {
    return await operation(database);
  } catch (error) {
    if (error instanceof ExportJobStoreError) throw error;
    throw new ExportJobStoreError('Export task storage operation failed', { cause: error });
  } finally {
    database.close();
  }
}

export async function putExportJob(
  job: StoredExportJob,
  changes: JobPayloadChanges = {},
): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(ALL_STORES, 'readwrite');
    const complete = transactionComplete(transaction);
    try {
      transaction.objectStore(EXPORT_JOBS_STORE).put(job);
      const files = transaction.objectStore(FILES_STORE);
      for (const file of changes.files ?? []) files.put({ ...file, jobId: job.id });
      for (const id of changes.removeFileIds ?? []) files.delete(id);
      if (changes.diagnostics === null) transaction.objectStore(DIAGNOSTICS_STORE).delete(job.id);
      else if (changes.diagnostics)
        transaction.objectStore(DIAGNOSTICS_STORE).put({ id: job.id, report: changes.diagnostics });
    } catch (error) {
      transaction.abort();
      await complete.catch(() => {});
      throw error;
    }
    await complete;
  });
}

async function readPayload<T>(store: string, id: string): Promise<T | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(store, 'readonly');
    const [value] = await Promise.all([
      requestResult(transaction.objectStore(store).get(id)),
      transactionComplete(transaction),
    ]);
    return value as T | undefined;
  });
}
export async function getExportJobBlob(id: string): Promise<Blob | undefined> {
  return (await readPayload<{ blob: Blob }>(FILES_STORE, id))?.blob;
}
export async function getExportJobDiagnostics(
  id: string,
): Promise<VideoDiagnosticsReport | undefined> {
  return (await readPayload<{ report: VideoDiagnosticsReport }>(DIAGNOSTICS_STORE, id))?.report;
}

export async function getExportJob(id: string): Promise<StoredExportJob | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(EXPORT_JOBS_STORE, 'readonly');
    const complete = transactionComplete(transaction);
    const [job] = await Promise.all([
      requestResult(transaction.objectStore(EXPORT_JOBS_STORE).get(id)),
      complete,
    ]);
    return job as StoredExportJob | undefined;
  });
}

export async function listExportJobs(): Promise<StoredExportJob[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(EXPORT_JOBS_STORE, 'readonly');
    const complete = transactionComplete(transaction);
    const [jobs] = await Promise.all([
      requestResult(transaction.objectStore(EXPORT_JOBS_STORE).getAll()),
      complete,
    ]);
    return (jobs as StoredExportJob[]).sort((left, right) =>
      right.summary.createdAt.localeCompare(left.summary.createdAt),
    );
  });
}

export async function deleteExportJob(id: string): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(ALL_STORES, 'readwrite');
    const complete = transactionComplete(transaction);
    transaction.objectStore(EXPORT_JOBS_STORE).delete(id);
    transaction.objectStore(DIAGNOSTICS_STORE).delete(id);
    const files = transaction.objectStore(FILES_STORE);
    const cursor = files.index('jobId').openKeyCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      files.delete(item.primaryKey);
      item.continue();
    };
    await complete;
  });
}
