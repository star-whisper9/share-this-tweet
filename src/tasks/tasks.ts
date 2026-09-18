import { downloadBlob } from '../core/download.js';
import {
  cancelExportJob,
  getExportJobDiagnostics,
  getExportJobFile,
  listExportJobs,
  markExportJobFileSaved,
  removeExportJob,
  retryExportJob,
} from '../core/job-client.js';
import type { JobSummary } from '../shared/export-jobs.js';
import { getLocale, localizeDocument, t } from '../shared/i18n.js';
import { loadSettings, watchLanguage } from '../shared/settings.js';

const list = document.querySelector<HTMLElement>('[data-list]');
const errorElement = document.querySelector<HTMLElement>('[data-error]');
const refreshButton = document.querySelector<HTMLButtonElement>('[data-refresh]');
const androidNote = document.querySelector<HTMLElement>('[data-android-note]');
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
  if (busyJobs.has(jobId)) element.disabled = true;
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
  size.textContent = `${formatBytes(file.size)} · ${file.cached ? t('jobs.cacheUntil', { time: formatCreatedAt(new Date(file.cacheExpiresAt).toISOString()) }) : t('jobs.cacheReleased')}`;
  details.append(name, size);
  row.append(details);

  const controls = document.createElement('div');
  if (file.saved && !isAndroid) {
    const state = document.createElement('span');
    state.className = 'file-size';
    state.textContent = t('jobs.autoSaved');
    controls.append(state);
  } else if (file.saved) {
    const state = document.createElement('span');
    state.className = 'file-size';
    state.textContent = t('jobs.downloadInitiated');
    controls.append(state);
  }
  if (file.cached)
    controls.append(
      button(
        file.saved && !isAndroid ? t('jobs.saveAgain') : t('jobs.download'),
        'download',
        job.id,
        {
          fileId: file.id,
        },
      ),
    );
  row.append(controls);
  return row;
}

function renderJob(job: JobSummary): HTMLElement {
  const card = document.createElement('article');
  card.className = 'task-card';
  const head = document.createElement('div');
  head.className = 'task-head';
  const title = document.createElement('div');
  title.className = 'task-title';
  const heading = document.createElement('h2');
  heading.textContent = kindLabel(job.kind);
  const author = document.createElement('p');
  author.className = 'task-author';
  author.textContent = job.author;
  title.append(heading, author);
  const status = document.createElement('span');
  status.className = `status status-${job.status}`;
  status.textContent = statusLabel(job.status);
  head.append(title, status);
  card.append(head);

  const meta = document.createElement('p');
  meta.className = 'task-meta';
  meta.textContent = `${t('jobs.fileCount', { count: job.files.length })} · ${t('jobs.createdAt', { time: formatCreatedAt(job.createdAt) })}`;
  card.append(meta);
  if (job.progress) {
    const progress = document.createElement('p');
    progress.className = 'task-message';
    progress.textContent = t('jobs.progress', { progress: job.progress });
    card.append(progress);
  }
  if (job.error) {
    const message = document.createElement('p');
    message.className = 'task-message error';
    message.textContent = t('jobs.error', { error: job.error });
    card.append(message);
  }
  for (const warning of job.warnings) {
    const message = document.createElement('p');
    message.className = 'task-message warning';
    message.textContent = t('jobs.warning', { warning });
    card.append(message);
  }
  if (job.files.length > 0) {
    const files = document.createElement('ul');
    files.className = 'file-list';
    for (const file of job.files) files.append(renderFile(job, file));
    card.append(files);
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
  if (actions.childElementCount > 0) card.append(actions);
  return card;
}

function render(): void {
  if (!list) return;
  const focused = document.activeElement;
  const focusedButton =
    focused instanceof HTMLButtonElement && list.contains(focused)
      ? {
          action: focused.dataset.action,
          jobId: focused.dataset.jobId,
          fileId: focused.dataset.fileId,
        }
      : undefined;
  const scrollTop = window.scrollY;
  list.replaceChildren();
  list.setAttribute('aria-busy', refreshing ? 'true' : 'false');
  if (jobs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = t('jobs.empty');
    list.append(empty);
  } else {
    for (const job of jobs) list.append(renderJob(job));
  }
  if (errorElement) {
    errorElement.hidden = !actionError;
    errorElement.textContent = actionError ?? '';
  }
  if (refreshButton) refreshButton.disabled = refreshing;
  if (focusedButton?.action && focusedButton.jobId) {
    const replacement = Array.from(
      list.querySelectorAll<HTMLButtonElement>('button[data-action][data-job-id]'),
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
  const blob = await getExportJobFile(jobId, fileId);
  downloadBlob(blob, file.filename);
  // Desktop downloads have already been handed to browser.downloads by the queue.
  // This manual control is only an additional download. Android cannot report an
  // OS-level save result, so record that the user initiated it from this page.
  if (isAndroid) await markExportJobFileSaved(jobId, fileId);
}

async function saveDiagnostics(jobId: string): Promise<void> {
  const report = await getExportJobDiagnostics(jobId);
  if (!report) throw new Error(t('jobs.notFound'));
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `X_${report.tweetId}_diagnostics_${report.jobId}.json`);
}

async function performAction(action: string, jobId: string, fileId?: string): Promise<void> {
  if (busyJobs.has(jobId)) return;
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

list?.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const action = target?.dataset.action;
  const jobId = target?.dataset.jobId;
  if (!action || !jobId) return;
  void performAction(action, jobId, target.dataset.fileId);
});
refreshButton?.addEventListener('click', () => void refresh(true));
if (androidNote) androidNote.hidden = !isAndroid;

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
