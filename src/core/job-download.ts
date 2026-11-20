import { isAndroidPlatform } from '../shared/platform.js';
import { downloadBlob } from './download.js';
import { downloadExportJobFile, getExportJobFile, markExportJobFileSaved } from './job-client.js';

export async function saveExportJobFile(
  jobId: string,
  fileId: string,
  filename: string,
): Promise<void> {
  if (await isAndroidPlatform()) {
    const blob = await getExportJobFile(jobId, fileId);
    downloadBlob(blob, filename);
    // Anchor activation is only a request; Android provides no download result.
    await markExportJobFileSaved(jobId, fileId);
  } else await downloadExportJobFile(jobId, fileId);
}
