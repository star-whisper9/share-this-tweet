import { fileCounts, isProcessing } from '../shared/job-list.js';
import type { JobSummary } from '../shared/export-jobs.js';
import { getLocale, t } from '../shared/i18n.js';

interface TaskViewState {
  isAndroid: boolean;
  expanded: ReadonlySet<string>;
  busyJobs: ReadonlySet<string>;
  batchRunning: boolean;
}

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
/** Build task cards from a snapshot of page state; actions stay in the page controller. */
export function createTaskView({ isAndroid, expanded, busyJobs, batchRunning }: TaskViewState) {
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

  return { renderJob };
}
