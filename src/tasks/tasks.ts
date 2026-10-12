import { createTaskView } from './tasks-view.js';
import { downloadBlob } from '../core/download.js';
import {
  cancelExportJob,
  clearExportJobCache,
  clearExportJobHistory,
  downloadExportJobFile,
  getExportJobDiagnostics,
  getExportJobFile,
  listExportJobs,
  markExportJobFileSaved,
  removeExportJob,
  retryExportJob,
  type ExportJobCleanupResult,
} from '../core/job-client.js';
import { filterJobs, pendingFiles, type StorageFilter } from '../shared/job-list.js';
import type { JobSummary } from '../shared/export-jobs.js';
import { localizeDocument, t } from '../shared/i18n.js';
import { loadSettings, watchLanguage } from '../shared/settings.js';

const list = document.querySelector<HTMLElement>('[data-list]');
const errorElement = document.querySelector<HTMLElement>('[data-error]');
const refreshButton = document.querySelector<HTMLButtonElement>('[data-refresh]');
const storageFilter = document.querySelector<HTMLSelectElement>('[data-storage]')!;
const dateFrom = document.querySelector<HTMLInputElement>('[data-from]')!;
const dateTo = document.querySelector<HTMLInputElement>('[data-to]')!;
const saveAll = document.querySelector<HTMLButtonElement>('[data-save-all]')!;
const stopBatch = document.querySelector<HTMLButtonElement>('[data-stop]')!;
const batchMessage = document.querySelector<HTMLElement>('[data-batch-message]')!;
const clearCacheButton = document.querySelector<HTMLButtonElement>('[data-clear-cache]')!;
const clearHistoryButton = document.querySelector<HTMLButtonElement>('[data-clear-history]')!;
const cleanupMessage = document.querySelector<HTMLElement>('[data-cleanup-message]')!;
let cleanupRunning = false;
let cleanupStatus: (ExportJobCleanupResult & { history: boolean }) | undefined;
const expanded = new Set<string>();
let batchRunning = false;
let batchStopRequested = false;
let batchStatus:
  | {
      key: 'jobs.batchProgress' | 'jobs.batchRequested' | 'jobs.batchSaved' | 'jobs.batchStopped';
      count: number;
      current: number;
      total: number;
    }
  | undefined;
const isAndroid = /\bAndroid\b/i.test(navigator.userAgent);
let jobs: JobSummary[] = [];
let refreshing = false;
let refreshRevision = 0;
let actionError: string | undefined;
const busyJobs = new Set<string>();

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function render(): void {
  if (!list) return;
  const focused = document.activeElement;
  const focusedButton =
    focused instanceof HTMLElement && !!focused.dataset.action && list.contains(focused)
      ? {
          action: focused.dataset.action,
          jobId: focused.dataset.jobId,
          fileId: focused.dataset.fileId,
        }
      : undefined;
  const scrollTop = window.scrollY;
  const invalidDates = !!dateFrom.value && !!dateTo.value && dateFrom.value > dateTo.value;
  const visibleJobs = invalidDates
    ? []
    : filterJobs(jobs, {
        storage: storageFilter.value as StorageFilter,
        from: dateFrom.value,
        to: dateTo.value,
      });
  list.replaceChildren();
  list.setAttribute('aria-busy', refreshing ? 'true' : 'false');
  if (visibleJobs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = t(
      invalidDates ? 'jobs.dateInvalid' : jobs.length ? 'jobs.noMatches' : 'jobs.empty',
    );
    list.append(empty);
  } else {
    const view = createTaskView({
      isAndroid,
      expanded,
      busyJobs,
      batchRunning: batchRunning || cleanupRunning,
    });
    for (const job of visibleJobs) list.append(view.renderJob(job));
  }
  const pending = pendingFiles(jobs).length;
  saveAll.textContent = t('jobs.saveAll', { count: pending });
  saveAll.disabled = !pending || batchRunning || cleanupRunning || busyJobs.size > 0;
  const settled = jobs.filter((job) => !['queued', 'running'].includes(job.status));
  const cleanupDisabled = cleanupRunning || batchRunning || busyJobs.size > 0;
  clearHistoryButton.disabled = cleanupDisabled || !settled.length;
  clearCacheButton.disabled =
    cleanupDisabled ||
    !settled.some((job) => job.hasDiagnostics || job.files.some((file) => file.cached));
  cleanupMessage.hidden = !cleanupStatus;
  cleanupMessage.textContent = cleanupStatus
    ? t(cleanupStatus.history ? 'jobs.historyCleared' : 'jobs.cacheCleared', {
        cleared: cleanupStatus.cleared,
        skipped: cleanupStatus.skipped,
      })
    : '';
  stopBatch.hidden = !batchRunning;
  stopBatch.disabled = batchStopRequested;
  batchMessage.hidden = !batchStatus;
  batchMessage.textContent = batchStatus ? t(batchStatus.key, batchStatus) : '';
  document.querySelector<HTMLElement>('[data-count]')!.textContent = t('jobs.taskCount', {
    count: visibleJobs.length,
  });
  if (errorElement) {
    errorElement.hidden = !actionError;
    errorElement.textContent = actionError ?? '';
  }
  if (refreshButton) refreshButton.disabled = refreshing || cleanupRunning;
  if (focusedButton?.action && focusedButton.jobId) {
    const replacement = Array.from(
      list.querySelectorAll<HTMLElement>('[data-action][data-job-id]'),
    ).find(
      (button) =>
        button.dataset.action === focusedButton.action &&
        button.dataset.jobId === focusedButton.jobId &&
        button.dataset.fileId === focusedButton.fileId,
    );
    replacement?.focus({ preventScroll: true });
  }
  window.scrollTo({ top: scrollTop });
}

function summariesMatch(left: JobSummary[], right: JobSummary[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function refresh(clearError = false): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  const revision = ++refreshRevision;
  try {
    const nextJobs = await listExportJobs();
    if (revision !== refreshRevision) return;
    const changed = !summariesMatch(jobs, nextJobs);
    jobs = nextJobs;
    if (clearError) actionError = undefined;
    if (changed || clearError) render();
  } catch (reason) {
    if (revision !== refreshRevision) return;
    const message = t('jobs.openError', { error: failureMessage(reason) });
    if (actionError !== message) {
      actionError = message;
      render();
    }
  } finally {
    if (revision === refreshRevision) {
      refreshing = false;
      list?.setAttribute('aria-busy', 'false');
      if (refreshButton) refreshButton.disabled = cleanupRunning;
    }
  }
}

async function saveFile(jobId: string, fileId: string): Promise<void> {
  const job = jobs.find((item) => item.id === jobId);
  const file = job?.files.find((item) => item.id === fileId);
  if (!job || !file) throw new Error(t('jobs.notFound'));
  if (isAndroid) {
    const blob = await getExportJobFile(jobId, fileId);
    downloadBlob(blob, file.filename);
    // Anchor activation is only a request; Android provides no download result.
    await markExportJobFileSaved(jobId, fileId);
  } else await downloadExportJobFile(jobId, fileId);
}

async function saveDiagnostics(jobId: string): Promise<void> {
  const report = await getExportJobDiagnostics(jobId);
  if (!report) throw new Error(t('jobs.notFound'));
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `X_${report.tweetId}_diagnostics_${report.jobId}.json`);
}

async function performAction(action: string, jobId: string, fileId?: string): Promise<void> {
  if (busyJobs.has(jobId) || batchRunning || cleanupRunning) return;
  busyJobs.add(jobId);
  actionError = undefined;
  render();
  try {
    if (action === 'cancel') await cancelExportJob(jobId);
    else if (action === 'retry') await retryExportJob(jobId);
    else if (action === 'remove') await removeExportJob(jobId);
    else if (action === 'download' && fileId) await saveFile(jobId, fileId);
    else if (action === 'diagnostics') await saveDiagnostics(jobId);
    else throw new Error(t('jobs.invalidRequest'));
    await refresh(true);
  } catch (reason) {
    actionError = t('jobs.actionFailed', { error: failureMessage(reason) });
  } finally {
    busyJobs.delete(jobId);
    render();
  }
}

async function saveBatch(targetJobs: JobSummary[]): Promise<void> {
  if (batchRunning || cleanupRunning || busyJobs.size) return;
  const targets = pendingFiles(targetJobs);
  if (!targets.length) return;
  batchRunning = true;
  batchStopRequested = false;
  actionError = undefined;
  let completed = 0;
  try {
    for (const target of targets) {
      if (batchStopRequested) break;
      batchStatus = {
        key: 'jobs.batchProgress',
        count: completed,
        current: completed + 1,
        total: targets.length,
      };
      render();
      await saveFile(target.jobId, target.fileId);
      completed++;
      // Space out Android requests; the browser may still ask for each file.
      if (isAndroid && completed < targets.length)
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    batchStatus = {
      key: batchStopRequested
        ? 'jobs.batchStopped'
        : isAndroid
          ? 'jobs.batchRequested'
          : 'jobs.batchSaved',
      count: completed,
      current: completed,
      total: targets.length,
    };
  } catch (reason) {
    batchStatus = undefined;
    actionError = t('jobs.batchFailed', { current: completed + 1, error: failureMessage(reason) });
  } finally {
    batchRunning = false;
    batchStopRequested = false;
    await refresh();
    render();
  }
}

async function clearTasks(history: boolean): Promise<void> {
  if (cleanupRunning || batchRunning || busyJobs.size) return;
  if (!window.confirm(t(history ? 'jobs.confirmClearHistory' : 'jobs.confirmClearCache'))) return;
  cleanupRunning = true;
  cleanupStatus = undefined;
  batchStatus = undefined;
  actionError = undefined;
  render();
  try {
    const result = await (history ? clearExportJobHistory() : clearExportJobCache());
    cleanupStatus = { ...result, history };
  } catch (reason) {
    actionError = t('jobs.actionFailed', { error: failureMessage(reason) });
  } finally {
    // A failed multi-task cleanup may have cleared earlier tasks already.
    await refresh();
    cleanupRunning = false;
    render();
  }
}

function toggleJob(jobId: string): void {
  if (expanded.has(jobId)) expanded.delete(jobId);
  else expanded.add(jobId);
  render();
}

list?.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  // Native links retain new-tab, context-menu and keyboard behavior.
  if (event.target.closest('a, input, select, textarea')) return;
  const target = event.target.closest<HTMLButtonElement>('button');
  if (target) {
    const { action, jobId, fileId } = target.dataset;
    if (target.disabled || !action || !jobId) return;
    if (action === 'toggle') toggleJob(jobId);
    else if (action === 'save-task') void saveBatch(jobs.filter((job) => job.id === jobId));
    else void performAction(action, jobId, fileId);
    return;
  }
  // Selecting filenames or diagnostic text should not collapse the card.
  if (window.getSelection()?.toString()) return;
  const card = event.target.closest<HTMLElement>('.task-card');
  if (card?.dataset.jobId) toggleJob(card.dataset.jobId);
});
refreshButton?.addEventListener('click', () => void refresh(true));
clearCacheButton.addEventListener('click', () => void clearTasks(false));
clearHistoryButton.addEventListener('click', () => void clearTasks(true));
for (const control of [storageFilter, dateFrom, dateTo]) control.addEventListener('change', render);
document.querySelector('[data-clear]')?.addEventListener('click', () => {
  storageFilter.value = 'all';
  dateFrom.value = dateTo.value = '';
  render();
});
saveAll.addEventListener('click', () => void saveBatch(jobs));
stopBatch.addEventListener('click', () => {
  batchStopRequested = true;
  render();
});
for (const note of Array.from(document.querySelectorAll<HTMLElement>('[data-android-note]')))
  note.hidden = !isAndroid;
if (isAndroid)
  document.querySelector<HTMLElement>('[data-saved-filter]')!.dataset.i18n = 'jobs.filterRequested';

const stopWatchingLanguage = watchLanguage(() => {
  localizeDocument();
  render();
  void refresh();
});
const poll = window.setInterval(() => void refresh(), 2000);
window.addEventListener(
  'pagehide',
  () => {
    window.clearInterval(poll);
    stopWatchingLanguage();
  },
  { once: true },
);
async function initialize(): Promise<void> {
  try {
    await loadSettings();
    localizeDocument();
    render();
  } catch (reason) {
    actionError = t('jobs.openError', { error: failureMessage(reason) });
    render();
    return;
  }
  await refresh();
}

void initialize();
