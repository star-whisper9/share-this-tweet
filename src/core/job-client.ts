import type { ExportJobRequest, JobSummary } from '../shared/export-jobs.js';
import type { VideoDiagnosticsReport } from './video-report.js';
import { t } from '../shared/i18n.js';

async function request(message: object): Promise<Record<string, unknown>> {
  const response: unknown = await browser.runtime.sendMessage(message);
  if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
    throw new Error(
      response &&
        typeof response === 'object' &&
        'error' in response &&
        typeof response.error === 'string'
        ? response.error
        : t('jobs.invalidResponse'),
    );
  }
  return response as Record<string, unknown>;
}
export async function enqueueExportJob(job: ExportJobRequest): Promise<string> {
  const result = await request({ type: 'export-job-enqueue', request: job });
  if (typeof result.id !== 'string' || result.id !== job.id)
    throw new Error(t('jobs.invalidResponse'));
  return result.id;
}
export async function listExportJobs(): Promise<JobSummary[]> {
  const result = await request({ type: 'export-job-list' });
  if (!Array.isArray(result.jobs)) throw new Error(t('jobs.invalidResponse'));
  return result.jobs as JobSummary[];
}
export async function openExportJobs(): Promise<void> {
  await request({ type: 'export-job-open' });
}
export async function cancelExportJob(id: string): Promise<void> {
  await request({ type: 'export-job-cancel', id });
}
export async function retryExportJob(id: string): Promise<void> {
  await request({ type: 'export-job-retry', id });
}
export async function removeExportJob(id: string): Promise<void> {
  await request({ type: 'export-job-remove', id });
}
export async function markExportJobFileSaved(id: string, fileId: string): Promise<void> {
  await request({ type: 'export-job-file-saved', id, fileId });
}
export async function getExportJobFile(id: string, fileId: string): Promise<Blob> {
  const result = await request({ type: 'export-job-file', id, fileId });
  if (!(result.blob instanceof Blob)) throw new Error(t('jobs.invalidResponse'));
  return result.blob;
}
export async function getExportJobDiagnostics(
  id: string,
): Promise<VideoDiagnosticsReport | undefined> {
  const result = await request({ type: 'export-job-diagnostics', id });
  if (result.diagnostics === undefined) return;
  if (
    !result.diagnostics ||
    typeof result.diagnostics !== 'object' ||
    !('schemaVersion' in result.diagnostics)
  )
    throw new Error(t('jobs.invalidResponse'));
  return result.diagnostics as VideoDiagnosticsReport;
}
