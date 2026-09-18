import { expect, it } from 'vitest';
import {
  appendVideoDiagnostic,
  isVideoDiagnosticSample,
  MAX_DIAGNOSTIC_SAMPLES,
  type VideoDiagnosticsReport,
} from '../src/core/video-report.js';

function report(): VideoDiagnosticsReport {
  return {
    schemaVersion: 1,
    jobId: 'test',
    tweetId: '42',
    engine: { name: 'ffmpeg.wasm', coreVersion: '0.12.10', threading: 'single', gpu: false },
    startedAt: '2026-09-19T00:00:00.000Z',
    status: 'running',
    elapsedMs: 0,
    mediaIndexes: [1],
    frame: 'bottom',
    style: 'seamless',
    samples: [],
    phaseDurationsMs: {},
    droppedSamples: 0,
    memoryMeasurement: 'wasm-linear-memory-capacity-and-memfs-files-not-process-rss',
  };
}
it('merges incremental metadata and retains final phase durations', () => {
  const value = report();
  appendVideoDiagnostic(
    value,
    { phase: 'loading', workerElapsedMs: 200, phaseElapsedMs: 200 },
    250,
    { inputBytes: 1000, downloadMs: 50 },
  );
  appendVideoDiagnostic(
    value,
    { phase: 'encoding', workerElapsedMs: 500, phaseElapsedMs: 300 },
    550,
    { inputBytes: 1000, output: { width: 720, height: 1378, duration: 135.7, frameRate: 27 } },
  );
  appendVideoDiagnostic(
    value,
    { phase: 'encoding', workerElapsedMs: 1500, phaseElapsedMs: 1300 },
    1550,
  );
  appendVideoDiagnostic(
    value,
    { phase: 'finalizing', workerElapsedMs: 1500, phaseElapsedMs: 0 },
    1550,
  );
  expect(value.metadata).toMatchObject({
    inputBytes: 1000,
    downloadMs: 50,
    output: { width: 720 },
  });
  expect(value.phaseDurationsMs).toMatchObject({ loading: 200, encoding: 1300, finalizing: 0 });
  expect(value.samples.at(-1)?.jobElapsedMs).toBe(1550);
  expect(value.elapsedMs).toBe(1550);
});
it('bounds retained samples explicitly and rejects invalid timing data', () => {
  const value = report();
  for (let index = 0; index <= MAX_DIAGNOSTIC_SAMPLES; index++)
    appendVideoDiagnostic(
      value,
      { phase: 'encoding', workerElapsedMs: index, phaseElapsedMs: index },
      index,
    );
  expect(value.samples).toHaveLength(MAX_DIAGNOSTIC_SAMPLES);
  expect(value.droppedSamples).toBe(1);
  expect(
    isVideoDiagnosticSample({ phase: 'encoding', workerElapsedMs: Number.NaN, phaseElapsedMs: 0 }),
  ).toBe(false);
  value.status = 'cancelled';
  appendVideoDiagnostic(value, { phase: 'done', workerElapsedMs: 9999, phaseElapsedMs: 1 }, 9999);
  expect(value.elapsedMs).toBe(MAX_DIAGNOSTIC_SAMPLES);
});
