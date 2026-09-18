import { expect, it } from 'vitest';
import { parseFfmpegProgress, VideoDiagnosticReporter } from '../src/core/video-diagnostics.js';

it('parses machine progress and ordinary FFmpeg stats without retaining source data', () => {
  expect(
    parseFfmpegProgress(
      'stdout: frame=42 fps=12.5 out_time_us=3000000 speed=1.20x total_size=123456',
    ),
  ).toEqual({
    frames: 42,
    fps: 12.5,
    encodedSeconds: 3,
    speed: 1.2,
    outputFileBytes: 123456,
  });
  expect(parseFfmpegProgress('frame= 7 fps=0.0 time=00:00:01.50 speed=0.50x')).toMatchObject({
    frames: 7,
    fps: 0,
    encodedSeconds: 1.5,
    speed: 0.5,
  });
  expect(
    parseFfmpegProgress('Starting second pass: moving the moov atom to the beginning of the file'),
  ).toEqual({
    finalizing: true,
  });
});

it('reports phase timing, a rolling encoder speed, and a monotonic WASM capacity peak', () => {
  let now = 0;
  let capacity = 16;
  const samples: Array<Record<string, number | string | undefined>> = [];
  const reporter = new VideoDiagnosticReporter({
    now: () => now,
    readMemory: () => ({ wasmCapacityBytes: capacity }),
    emit: (sample) => samples.push(sample),
  });

  reporter.setPhase('encoding');
  now = 1_000;
  capacity = 32;
  reporter.noteFfmpegLog('frame=10 out_time_us=2000000 progress=continue');
  reporter.sample(true);
  now = 3_000;
  capacity = 24;
  reporter.noteFfmpegLog('frame=30 out_time_us=6000000 progress=continue');
  reporter.setPhase('finalizing');
  now = 3_200;
  reporter.sample(true);

  expect(samples[3]).toMatchObject({
    phase: 'encoding',
    workerElapsedMs: 3_000,
    phaseElapsedMs: 3_000,
    recentSpeed: 2,
    recentFps: 10,
    wasmCapacityBytes: 24,
    wasmPeakCapacityBytes: 32,
  });
  expect(samples[4]).toMatchObject({ phase: 'encoding', phaseElapsedMs: 3_000 });
  expect(samples.at(-1)).toMatchObject({
    phase: 'finalizing',
    phaseElapsedMs: 200,
    recentSpeed: 2,
    recentFps: 10,
  });
});

it('does not sample more frequently than the configured callback-driven interval', () => {
  let now = 0;
  const samples: unknown[] = [];
  const reporter = new VideoDiagnosticReporter({
    now: () => now,
    sampleIntervalMs: 2_000,
    emit: (sample) => samples.push(sample),
  });
  reporter.setPhase('encoding');
  now = 1_999;
  reporter.sample();
  now = 2_000;
  reporter.sample();
  expect(samples).toHaveLength(3);
});

it('pairs machine metrics only when an FFmpeg progress block is complete', () => {
  let now = 0;
  const samples: Array<{ frames?: number; encodedSeconds?: number }> = [];
  const reporter = new VideoDiagnosticReporter({
    now: () => now,
    sampleIntervalMs: 0,
    emit: (sample) => samples.push(sample),
  });
  reporter.setPhase('encoding');
  reporter.noteFfmpegLog('frame=10');
  reporter.noteFfmpegLog('out_time_us=2000000');
  expect(samples).toHaveLength(2);
  now = 1_000;
  reporter.noteFfmpegLog('speed=1.5x progress=continue');
  expect(samples.at(-1)).toMatchObject({ frames: 10, encodedSeconds: 2 });
});
