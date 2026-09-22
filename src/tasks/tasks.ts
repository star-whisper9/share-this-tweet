import { downloadBlob } from '../core/download.js';
import {
  cancelExportJob,
  downloadExportJobFile,
  getExportJobDiagnostics,
  getExportJobFile,
  listExportJobs,
  markExportJobFileSaved,
  removeExportJob,
  retryExportJob,
} from '../core/job-client.js';
import {
  fileCounts,
  filterJobs,
  isProcessing,
  pendingFiles,
  type StorageFilter,
} from '../shared/job-list.js';
import type { JobSummary } from '../shared/export-jobs.js';
import { getLocale, localizeDocument, t } from '../shared/i18n.js';
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
const terminalStatuses = new Set<JobSummary['status']>([
  'ready',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'expired',
]);
const retryableStatuses = new Set<JobSummary['status']>([
  'failed',
  'cancelled',
  'interrupted',
  'expired',
]);
let jobs: JobSummary[] = [];
let refreshing = false;
let refreshRevision = 0;
let actionError: string | undefined;
const busyJobs = new Set<string>();

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(
    date,
  );
}

function statusLabel(status: JobSummary['status']): string {
  return t(`jobs.status.${status}` as keyof typeof import('../shared/locales/jobs.js').zhCN);
}

function kindLabel(kind: JobSummary['kind']): string {
  return t(`jobs.kind.${kind}` as keyof typeof import('../shared/locales/jobs.js').zhCN);
}

function button(
  label: string,
  action: string,
  jobId: string,
  extra: Record<string, string> = {},
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'button button-small';
  element.textContent = label;
  element.dataset.action = action;
  element.dataset.jobId = jobId;
  for (const [key, value] of Object.entries(extra)) element.dataset[key] = value;
  if (action !== 'toggle' && (busyJobs.has(jobId) || batchRunning)) element.disabled = true;
  return element;
}

function renderFile(job: JobSummary, file: JobSummary['files'][number]): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'file-row';
  const details = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = file.filename;
  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = `${formatBytes(file.size)} · ${file.cached ? t('jobs.cacheUntil', { time: formatCreatedAt(new Date(file.cacheExpiresAt).toISOString()) }) : t('jobs.cacheGone')}`;
  details.append(name, size);
  row.append(details);

  const controls = document.createElement('div');
  const state = document.createElement('span');
  const cached = file.cached && file.cacheExpiresAt > Date.now();
  state.className = `file-state ${file.saved ? (isAndroid ? 'requested' : 'saved') : cached ? 'pending' : 'unavailable'}`;
  state.textContent = file.saved
    ? t(isAndroid ? 'jobs.downloadInitiated' : 'jobs.autoSaved')
    : t(cached ? 'jobs.filePending' : 'jobs.fileUnavailable');
  controls.append(state);
  if (cached && !isProcessing(job))
    controls.append(
      button(file.saved ? t('jobs.saveAgain') : t('jobs.download'), 'download', job.id, {
        fileId: file.id,
      }),
    );
  row.append(controls);
  return row;
}

function renderJob(job: JobSummary): HTMLElement {
  const card = document.createElement('article');
  card.className = 'task-card';
  card.dataset.jobId = job.id;
  const head = document.createElement('div');
  head.className = 'task-head';
  const toggle = button('', 'toggle', job.id);
  toggle.className = 'task-toggle';
  const isExpanded = expanded.has(job.id);
  toggle.setAttribute('aria-expanded', String(isExpanded));
  toggle.setAttribute('aria-controls', `details-${job.id}`);
  const title = document.createElement('span');
  title.className = 'task-title';
  const heading = document.createElement('a');
  heading.className = 'task-source';
  heading.href = `https://x.com/i/status/${encodeURIComponent(job.tweetId)}`;
  heading.target = '_blank';
  heading.rel = 'noopener noreferrer';
  heading.dataset.action = 'source';
  heading.dataset.jobId = job.id;
  heading.textContent = `${kindLabel(job.kind)} · ${job.author}`;
  const meta = document.createElement('span');
  meta.className = 'task-meta';
  meta.textContent = `${formatCreatedAt(job.createdAt)} · ${t('jobs.fileCount', { count: job.files.length })}`;
  title.append(heading, meta);
  const chevron = document.createElement('span');
  chevron.className = 'task-chevron';
  chevron.textContent = isExpanded ? '▾' : '▸';
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(chevron);
  toggle.title = t(isExpanded ? 'jobs.collapse' : 'jobs.expand');
  toggle.setAttribute('aria-label', toggle.title);
  head.append(title, toggle);
  card.append(head);

  const overview = document.createElement('div');
  overview.className = 'task-overview';
  const counts = fileCounts(job);
  for (const [count, key, state] of [
    [counts.pending, 'jobs.pendingCount', 'pending'],
    [
      counts.saved,
      isAndroid ? 'jobs.requestedCount' : 'jobs.savedCount',
      isAndroid ? 'requested' : 'saved',
    ],
    [counts.unavailable, 'jobs.unavailableCount', 'unavailable'],
  ] as const) {
    if (!count) continue;
    const badge = document.createElement('span');
    badge.className = `file-state ${state}`;
    badge.textContent = t(key, { count });
    overview.append(badge);
  }
  if (!['ready', 'completed'].includes(job.status)) {
    const status = document.createElement('span');
    status.className = `process-status status-${job.status}`;
    status.textContent = statusLabel(job.status);
    overview.append(status);
  }
  if (counts.pending && !isProcessing(job))
    overview.append(button(t('jobs.saveTask', { count: counts.pending }), 'save-task', job.id));
  card.append(overview);

  const details = document.createElement('div');
  details.id = `details-${job.id}`;
  details.hidden = !isExpanded;
  details.className = 'task-details';
  card.append(details);
  if (job.progress) {
    const progress = document.createElement('p');
    progress.className = 'task-message';
    progress.textContent = t('jobs.progress', { progress: job.progress });
    card.insertBefore(progress, details);
  }
  if (job.error) {
    const message = document.createElement('p');
    message.className = 'task-message error';
    message.textContent = t('jobs.error', { error: job.error });
    details.append(message);
  }
  for (const warning of job.warnings) {
    const message = document.createElement('p');
    message.className = 'task-message warning';
    message.textContent = t('jobs.warning', { warning });
    details.append(message);
  }
  if (job.files.length > 0) {
    const files = document.createElement('ul');
    files.className = 'file-list';
    for (const file of job.files) files.append(renderFile(job, file));
    details.append(files);
  }

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  if (job.status === 'queued' || job.status === 'running') {
    actions.append(button(t('jobs.cancel'), 'cancel', job.id));
  }
  if (retryableStatuses.has(job.status)) actions.append(button(t('jobs.retry'), 'retry', job.id));
  if (job.hasDiagnostics)
    actions.append(button(t('jobs.downloadDiagnostics'), 'diagnostics', job.id));
  if (terminalStatuses.has(job.status)) {
    const remove = button(t('jobs.remove'), 'remove', job.id);
    remove.classList.add('button-danger');
    actions.append(remove);
  }
  if (actions.childElementCount > 0) details.append(actions);
  return card;
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
    for (const job of visibleJobs) list.append(renderJob(job));
  }
  const pending = pendingFiles(jobs).length;
  saveAll.textContent = t('jobs.saveAll', { count: pending });
  saveAll.disabled = !pending || batchRunning || busyJobs.size > 0;
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
  if (refreshButton) refreshButton.disabled = refreshing;
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
      if (refreshButton) refreshButton.disabled = false;
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
  if (busyJobs.has(jobId) || batchRunning) return;
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
  if (batchRunning || busyJobs.size) return;
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
