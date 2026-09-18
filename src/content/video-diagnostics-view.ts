import type { ExportSession } from './export-session.js';
import { actionButton, node } from './ui-components.js';
import { t } from '../shared/i18n.js';

function metric(value: number | undefined, unit = '', divisor = 1): string {
  return value === undefined || !Number.isFinite(value)
    ? '—'
    : `${(value / divisor).toFixed(1)}${unit}`;
}
export function videoDiagnosticsView(session: ExportSession): HTMLDetailsElement | undefined {
  const report = session.videoDiagnostics;
  if (!report) return;
  const sample = report.samples.at(-1);
  const details = node('details', 'stt-video-diagnostics');
  details.append(node('summary', '', t('diagnostics.title')));
  const data = node('dl', '');
  const phase =
    report.status === 'running'
      ? sample
        ? t(`diagnostics.phase.${sample.phase}`)
        : t('dynamic.progress.downloading')
      : t(`diagnostics.status.${report.status}`);
  const rows: Array<[string, string]> = [
    [t('diagnostics.phase'), phase],
    [
      t('diagnostics.elapsed'),
      `${metric(report.elapsedMs, ' s', 1000)} / ${metric(report.phaseDurationsMs.encoding, ' s', 1000)}`,
    ],
    [
      t('diagnostics.mediaTime'),
      `${metric(sample?.encodedSeconds, ' s')} / ${metric(report.metadata?.output?.duration, ' s')}`,
    ],
    [t('diagnostics.speed'), `${metric(sample?.recentSpeed, '×')} / ${metric(sample?.speed, '×')}`],
    [t('diagnostics.fps'), `${metric(sample?.recentFps)} / ${metric(sample?.fps)}`],
    [
      t('diagnostics.wasm'),
      `${metric(sample?.wasmCapacityBytes, ' MiB', 1024 * 1024)} / ${metric(sample?.wasmPeakCapacityBytes, ' MiB', 1024 * 1024)}`,
    ],
    [
      t('diagnostics.output'),
      `${metric(report.resultBytes ?? sample?.outputFileBytes, ' MiB', 1024 * 1024)} / ${metric(sample?.outputBufferCapacityBytes, ' MiB', 1024 * 1024)}`,
    ],
    [
      t('diagnostics.startup'),
      `${metric(report.metadata?.downloadMs, ' s', 1000)} / ${metric(report.phaseDurationsMs.loading, ' s', 1000)}`,
    ],
    [
      t('diagnostics.finishing'),
      `${metric(report.phaseDurationsMs.finalizing, ' s', 1000)} / ${metric(report.phaseDurationsMs['reading-output'], ' s', 1000)} / ${metric(report.phaseDurationsMs['copying-output'], ' s', 1000)}`,
    ],
  ];
  for (const [label, value] of rows) data.append(node('dt', '', label), node('dd', '', value));
  details.append(data, node('p', 'stt-save-hint', t('diagnostics.memoryNote')));
  if (sample?.samplingError) details.append(node('p', 'stt-save-hint', sample.samplingError));
  details.append(
    actionButton({
      key: `video-diagnostics-${session.record.tweetId}`,
      label: t('diagnostics.download'),
      image: 'download',
      state: { status: 'idle' },
      onClick: () => session.saveVideoDiagnostics(),
    }),
  );
  return details;
}
