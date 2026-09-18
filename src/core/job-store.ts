import type { VideoDiagnosticsReport } from './video-report.js';
import type { ExportJobFile, ExportJobRequest, JobSummary } from '../shared/export-jobs.js';

export const EXPORT_JOBS_DATABASE_NAME = 'share-this-tweet.export-jobs';
export const EXPORT_JOBS_DATABASE_VERSION = 1;
export const EXPORT_JOBS_STORE = 'jobs';

export interface StoredExportJobFile extends ExportJobFile {
  saved: boolean;
}

/**
 * The complete render request and generated Blobs live together. Keeping this
 * separate from tweet history lets a user remove a task without deleting its
 * source record, and lets a queued task survive an originating tab closing.
 */
export interface StoredExportJob {
  id: string;
  request: ExportJobRequest;
  summary: JobSummary;
  files: StoredExportJobFile[];
  diagnostics?: VideoDiagnosticsReport;
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
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(EXPORT_JOBS_STORE)
        ? request.transaction!.objectStore(EXPORT_JOBS_STORE)
        : database.createObjectStore(EXPORT_JOBS_STORE, { keyPath: 'id' });
      if (!store.indexNames.contains('createdAt')) {
        store.createIndex('createdAt', 'summary.createdAt', { unique: false });
      }
      if (!store.indexNames.contains('status')) {
        store.createIndex('status', 'summary.status', { unique: false });
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

export async function putExportJob(job: StoredExportJob): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(EXPORT_JOBS_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    await Promise.all([
      requestResult(transaction.objectStore(EXPORT_JOBS_STORE).put(job)),
      complete,
    ]);
  });
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
    const transaction = database.transaction(EXPORT_JOBS_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    await Promise.all([
      requestResult(transaction.objectStore(EXPORT_JOBS_STORE).delete(id)),
      complete,
    ]);
  });
}
