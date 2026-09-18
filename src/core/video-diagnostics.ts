import type { VideoDiagnosticPhase, VideoDiagnosticSample } from '../shared/video-render.js';

export interface ParsedFfmpegProgress {
  encodedSeconds?: number;
  frames?: number;
  fps?: number;
  speed?: number;
  outputFileBytes?: number;
  progress?: 'continue' | 'end';
  finalizing?: boolean;
}

export interface VideoDiagnosticMemorySample {
  wasmCapacityBytes?: number;
  inputFileBytes?: number;
  outputFileBytes?: number;
  outputBufferCapacityBytes?: number;
  samplingError?: string;
}

export interface VideoDiagnosticReporterOptions {
  emit(sample: VideoDiagnosticSample): void;
  readMemory?(): VideoDiagnosticMemorySample;
  now?(): number;
  sampleIntervalMs?: number;
}

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function parseClock(value: string): number | undefined {
  const parts = value.split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const seconds = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return seconds >= 0 ? seconds : undefined;
}

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

/** Parse both FFmpeg's `-progress` key/value output and its ordinary stats line. */
export function parseFfmpegProgress(line: string): ParsedFfmpegProgress {
  const text = line.replace(/^\s*(?:stdout|stderr|ffout|fferr)\s*:\s*/i, '').trim();
  const result: ParsedFfmpegProgress = {};
  if (/Starting second pass:\s*moving the moov atom/i.test(text)) result.finalizing = true;

  const keyValues = new Map<string, string>();
  for (const match of text.matchAll(
    /(?:^|\s)(frame|fps|out_time_us|out_time_ms|out_time|speed|total_size|time|progress)\s*=\s*([^\s]+)/g,
  ))
    keyValues.set(match[1]!, match[2]!);

  result.frames = numberFrom(keyValues.get('frame'));
  result.fps = numberFrom(keyValues.get('fps'));
  result.speed = numberFrom(keyValues.get('speed')?.replace(/x$/i, ''));
  result.outputFileBytes = numberFrom(keyValues.get('total_size'));
  const progress = keyValues.get('progress');
  if (progress === 'continue' || progress === 'end') result.progress = progress;
  const microseconds = numberFrom(keyValues.get('out_time_us'));
  // FFmpeg's `out_time_ms` is historically named and still reports microseconds.
  const legacyMicroseconds = numberFrom(keyValues.get('out_time_ms'));
  const encodedClock = keyValues.get('out_time') ?? keyValues.get('time');
  if (finitePositive(microseconds)) result.encodedSeconds = microseconds / 1_000_000;
  else if (finitePositive(legacyMicroseconds))
    result.encodedSeconds = legacyMicroseconds / 1_000_000;
  else if (encodedClock) result.encodedSeconds = parseClock(encodedClock);
  return result;
}

/**
 * Keeps timing and peak-capacity accounting outside FFmpeg calls. Sampling is
 * driven by FFmpeg callbacks, so a synchronous `core.exec()` never needs an
 * interval timer.
 */
export class VideoDiagnosticReporter {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly startedAt: number;
  private phaseStartedAt: number;
  private lastEmittedAt = Number.NEGATIVE_INFINITY;
  private peakCapacityBytes: number | undefined;
  private phase: VideoDiagnosticPhase = 'loading';
  private values: Omit<VideoDiagnosticSample, 'phase' | 'workerElapsedMs' | 'phaseElapsedMs'> = {};
  private window: { elapsedMs: number; encodedSeconds?: number; frames?: number } | undefined;
  private recent: Pick<VideoDiagnosticSample, 'recentFps' | 'recentSpeed'> = {};
  private pendingProgress: Pick<
    ParsedFfmpegProgress,
    'encodedSeconds' | 'frames' | 'fps' | 'speed' | 'outputFileBytes'
  > = {};

  constructor(private readonly options: VideoDiagnosticReporterOptions) {
    this.now = options.now ?? performance.now.bind(performance);
    this.intervalMs = options.sampleIntervalMs ?? 2_000;
    this.startedAt = this.now();
    this.phaseStartedAt = this.startedAt;
  }

  setPhase(phase: VideoDiagnosticPhase, force = true): void {
    if (phase === this.phase) {
      this.sample(force);
      return;
    }
    // Emit the old phase before resetting its clock, then start the new phase
    // at zero. This leaves a reliable final duration for short tail stages.
    this.sample(true);
    this.phase = phase;
    this.phaseStartedAt = this.now();
    this.sample(true);
  }

  update(
    values: Partial<Omit<VideoDiagnosticSample, 'phase' | 'workerElapsedMs' | 'phaseElapsedMs'>>,
  ): void {
    this.values = { ...this.values, ...values };
  }

  noteFfmpegLog(line: string): void {
    const parsed = parseFfmpegProgress(line);
    const measurements = {
      ...(parsed.encodedSeconds !== undefined ? { encodedSeconds: parsed.encodedSeconds } : {}),
      ...(parsed.frames !== undefined ? { frames: parsed.frames } : {}),
      ...(parsed.fps !== undefined ? { fps: parsed.fps } : {}),
      ...(parsed.speed !== undefined ? { speed: parsed.speed } : {}),
      ...(parsed.outputFileBytes !== undefined ? { outputFileBytes: parsed.outputFileBytes } : {}),
    };
    this.pendingProgress = { ...this.pendingProgress, ...measurements };
    if (parsed.finalizing) this.setPhase('finalizing');
    // `-progress pipe:1` emits a key at a time. Wait for its terminator so
    // frame count, encoded time and speed always describe the same interval.
    if (!parsed.progress) return;
    this.update(this.pendingProgress);
    this.pendingProgress = {};
    const current = {
      elapsedMs: this.now() - this.startedAt,
      encodedSeconds: this.values.encodedSeconds,
      frames: this.values.frames,
    };
    this.recent = this.window ? this.recentMetrics(this.window, current) : {};
    this.window = current;
    this.sample(parsed.progress === 'end');
  }

  sample(force = false): VideoDiagnosticSample | undefined {
    const now = this.now();
    if (!force && now - this.lastEmittedAt < this.intervalMs) return undefined;
    const sample = this.createSample(now);
    this.lastEmittedAt = now;
    this.options.emit(sample);
    return sample;
  }

  snapshot(): VideoDiagnosticSample {
    return this.createSample(this.now());
  }

  private createSample(now: number): VideoDiagnosticSample {
    const elapsedMs = now - this.startedAt;
    const memory = this.readMemory();
    if (finitePositive(memory.wasmCapacityBytes))
      this.peakCapacityBytes = Math.max(this.peakCapacityBytes ?? 0, memory.wasmCapacityBytes);
    return {
      phase: this.phase,
      workerElapsedMs: elapsedMs,
      phaseElapsedMs: now - this.phaseStartedAt,
      ...this.values,
      ...this.recent,
      ...memory,
      ...(this.peakCapacityBytes !== undefined
        ? { wasmPeakCapacityBytes: this.peakCapacityBytes }
        : {}),
    };
  }

  private readMemory(): VideoDiagnosticMemorySample {
    try {
      return this.options.readMemory?.() ?? {};
    } catch (error) {
      return { samplingError: error instanceof Error ? error.message : String(error) };
    }
  }

  private recentMetrics(
    previous: { elapsedMs: number; encodedSeconds?: number; frames?: number },
    current: { elapsedMs: number; encodedSeconds?: number; frames?: number },
  ): Pick<VideoDiagnosticSample, 'recentFps' | 'recentSpeed'> {
    const elapsedSeconds = (current.elapsedMs - previous.elapsedMs) / 1_000;
    if (!(elapsedSeconds > 0)) return {};
    const result: Pick<VideoDiagnosticSample, 'recentFps' | 'recentSpeed'> = {};
    if (
      current.encodedSeconds !== undefined &&
      previous.encodedSeconds !== undefined &&
      current.encodedSeconds > previous.encodedSeconds
    )
      result.recentSpeed = (current.encodedSeconds - previous.encodedSeconds) / elapsedSeconds;
    if (
      current.frames !== undefined &&
      previous.frames !== undefined &&
      current.frames > previous.frames
    )
      result.recentFps = (current.frames - previous.frames) / elapsedSeconds;
    return result;
  }
}
