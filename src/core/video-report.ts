import type {
  VideoDiagnosticMetadata,
  VideoDiagnosticPhase,
  VideoDiagnosticSample,
} from '../shared/video-render.js';

export const MAX_DIAGNOSTIC_SAMPLES = 2000;
export interface VideoDiagnosticsReport {
  schemaVersion: 1;
  jobId: string;
  tweetId: string;
  engine: { name: 'ffmpeg.wasm'; coreVersion: '0.12.10'; threading: 'single'; gpu: false };
  startedAt: string;
  userAgent?: string;
  extensionVersion?: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  elapsedMs: number;
  mediaIndexes: number[];
  frame: 'original' | 'top' | 'bottom';
  style: 'seamless' | 'gallery';
  metadata?: VideoDiagnosticMetadata;
  samples: Array<VideoDiagnosticSample & { jobElapsedMs: number }>;
  phaseDurationsMs: Partial<Record<VideoDiagnosticPhase, number>>;
  droppedSamples: number;
  resultBytes?: number;
  error?: string;
  memoryMeasurement: 'wasm-linear-memory-capacity-and-memfs-files-not-process-rss';
}

export function isVideoDiagnosticSample(value: unknown): value is VideoDiagnosticSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Partial<VideoDiagnosticSample>;
  return (
    [
      'loading',
      'writing-input',
      'probing',
      'frame',
      'encoding',
      'finalizing',
      'reading-output',
      'copying-output',
      'cleanup',
      'done',
      'error',
    ].includes(sample.phase ?? '') &&
    typeof sample.workerElapsedMs === 'number' &&
    Number.isFinite(sample.workerElapsedMs) &&
    sample.workerElapsedMs >= 0 &&
    typeof sample.phaseElapsedMs === 'number' &&
    Number.isFinite(sample.phaseElapsedMs) &&
    sample.phaseElapsedMs >= 0
  );
}

/** Retain both raw library progress and measured speed; never infer RSS from capacity. */
export function appendVideoDiagnostic(
  report: VideoDiagnosticsReport,
  sample: VideoDiagnosticSample,
  elapsedMs: number,
  metadata?: VideoDiagnosticMetadata,
): void {
  if (report.status !== 'running') return;
  if (!isVideoDiagnosticSample(sample) || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new Error('Invalid video diagnostic sample');
  if (metadata) report.metadata = { ...report.metadata, ...metadata };
  report.elapsedMs = elapsedMs;
  report.phaseDurationsMs[sample.phase] = Math.max(
    report.phaseDurationsMs[sample.phase] ?? 0,
    sample.phaseElapsedMs,
  );
  report.samples.push({ ...sample, jobElapsedMs: elapsedMs });
  if (report.samples.length > MAX_DIAGNOSTIC_SAMPLES) {
    report.samples.shift();
    report.droppedSamples++;
  }
}
