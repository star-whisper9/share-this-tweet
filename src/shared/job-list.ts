import type { JobSummary } from './export-jobs.js';

export type StorageFilter = 'all' | 'pending' | 'saved' | 'unavailable' | 'processing';
export interface JobFilter {
  storage: StorageFilter;
  from: string;
  to: string;
}

export function newestJobsFirst(left: JobSummary, right: JobSummary): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

export function isProcessing(job: JobSummary): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function fileCounts(job: JobSummary, now = Date.now()) {
  const saved = job.files.filter((file) => file.saved).length;
  const pending = job.files.filter(
    (file) => !file.saved && file.cached && file.cacheExpiresAt > now,
  ).length;
  return { saved, pending, unavailable: job.files.length - saved - pending };
}

/** Compare calendar dates in the user's timezone; include the entire end date. */
export function filterJobs(jobs: JobSummary[], filter: JobFilter, now = Date.now()): JobSummary[] {
  return jobs
    .filter((job) => {
      const date = new Date(job.createdAt);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      if ((filter.from && day < filter.from) || (filter.to && day > filter.to)) return false;
      const counts = fileCounts(job, now);
      switch (filter.storage) {
        case 'pending':
          return counts.pending > 0;
        case 'saved':
          return job.files.length > 0 && counts.saved === job.files.length;
        case 'unavailable':
          return counts.unavailable > 0;
        case 'processing':
          return isProcessing(job);
        default:
          return true;
      }
    })
    .sort(newestJobsFirst);
}

/** Take a fixed snapshot. Never compete with the queue's automatic downloads. */
export function pendingFiles(jobs: JobSummary[], now = Date.now()) {
  return [...jobs]
    .sort(newestJobsFirst)
    .filter((job) => !isProcessing(job))
    .flatMap((job) =>
      job.files
        .filter((file) => !file.saved && file.cached && file.cacheExpiresAt > now)
        .map((file) => ({ jobId: job.id, fileId: file.id })),
    );
}
