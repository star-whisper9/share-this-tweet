import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportJobRequest } from '../src/shared/export-jobs.js';
import type { VideoDiagnosticsReport } from '../src/core/video-report.js';
import { JOB_RETENTION } from '../src/shared/job-retention.js';
import type { JobPayloadChanges, StoredExportJob } from '../src/core/job-store.js';

const mocks = vi.hoisted(() => ({
  jobs: new Map<string, StoredExportJob>(),
  blobs: new Map<string, Blob>(),
  diagnostics: new Map<string, VideoDiagnosticsReport>(),
  render: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  output: vi.fn(),
  tweet: vi.fn(),
}));

vi.mock('../src/core/job-store.js', () => ({
  getExportJob: vi.fn(async (id: string) => mocks.jobs.get(id)),
  getExportJobBlob: vi.fn(async (id: string) => mocks.blobs.get(id)),
  getExportJobDiagnostics: vi.fn(async (id: string) => mocks.diagnostics.get(id)),
  listExportJobs: vi.fn(async () => Array.from(mocks.jobs.values())),
  putExportJob: mocks.put.mockImplementation(
    async (job: StoredExportJob, changes: JobPayloadChanges = {}) => {
      mocks.jobs.set(job.id, job);
      for (const file of changes.files ?? []) mocks.blobs.set(file.id, file.blob);
      for (const id of changes.removeFileIds ?? []) mocks.blobs.delete(id);
      if (changes.diagnostics === null) mocks.diagnostics.delete(job.id);
      else if (changes.diagnostics) mocks.diagnostics.set(job.id, changes.diagnostics);
    },
  ),
  deleteExportJob: mocks.remove.mockImplementation(async (id: string) => {
    for (const file of mocks.jobs.get(id)?.files ?? []) mocks.blobs.delete(file.id);
    mocks.diagnostics.delete(id);
    mocks.jobs.delete(id);
  }),
}));
vi.mock('../src/core/job-renderer.js', () => ({ renderExportJob: mocks.render }));
vi.mock('../src/core/storage.js', () => ({
  recordOutput: mocks.output,
  upsertTweetRecord: mocks.tweet,
}));

let downloadsChanged: (delta: unknown) => void;
const download = vi.fn(async () => 9);
const search = vi.fn(async () => [{ id: 9, state: 'complete' }]);
const cancel = vi.fn(async () => undefined);

function request(id: string): ExportJobRequest {
  return {
    id,
    kind: 'media',
    record: {
      tweetId: '42',
      url: 'https://x.com/alice/status/42',
      text: 'hello',
      author: { id: '1', handle: 'alice', name: 'Alice' },
      media: [{ index: 1, type: 'photo', originalUrl: 'https://pbs.twimg.com/photo.jpg' }],
    },
    settings: {
      language: 'en',
      experimentalVideo: true,
      videoLimits: {
        maxInputMiB: 0,
        maxDurationSeconds: 0,
        maxOutputPixels: 0,
        maxFrameRate: 0,
      },
      filenameTemplate: '{tweet.id}',
      frameTemplate: '{tweet.text}',
      frameOrientation: 'bottom',
      textTemplate: '{tweet.text}',
      stitchStyle: 'seamless',
    },
    theme: 'light',
    locale: 'en',
    media: [{ index: 1, mode: 'original', orientation: 'bottom' }],
  };
}

function file(id: string) {
  return {
    id: `${id}:media:1`,
    filename: `${id}.jpg`,
    blob: new Blob(['image'], { type: 'image/jpeg' }),
    output: { tweetId: '42', outputType: 'original-media' as const, filename: `${id}.jpg` },
  };
}

async function summaries() {
  const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
  return handleExportJobMessage({ type: 'export-job-list' }) as Promise<{
    ok: boolean;
    jobs: Array<{ id: string; status: string; files: Array<{ saved: boolean }> }>;
  }>;
}

beforeEach(() => {
  vi.resetModules();
  mocks.jobs.clear();
  mocks.blobs.clear();
  mocks.diagnostics.clear();
  mocks.render.mockReset();
  mocks.put
    .mockReset()
    .mockImplementation(async (job: StoredExportJob, changes: JobPayloadChanges = {}) => {
      mocks.jobs.set(job.id, structuredClone(job));
      for (const file of changes.files ?? []) mocks.blobs.set(file.id, file.blob);
      for (const id of changes.removeFileIds ?? []) mocks.blobs.delete(id);
      if (changes.diagnostics === null) mocks.diagnostics.delete(job.id);
      else if (changes.diagnostics)
        mocks.diagnostics.set(job.id, structuredClone(changes.diagnostics));
    });
  mocks.remove.mockReset().mockImplementation(async (id: string) => {
    for (const file of mocks.jobs.get(id)?.files ?? []) mocks.blobs.delete(file.id);
    mocks.diagnostics.delete(id);
    mocks.jobs.delete(id);
  });
  mocks.output.mockReset().mockResolvedValue(undefined);
  mocks.tweet.mockReset().mockResolvedValue(undefined);
  download.mockClear();
  search.mockReset().mockResolvedValue([{ id: 9, state: 'complete' }]);
  cancel.mockClear();
  vi.stubGlobal('browser', {
    runtime: { getURL: (path: string) => `moz-extension://test/${path}` },
    downloads: {
      download,
      search,
      cancel,
      onChanged: {
        addListener: (listener: typeof downloadsChanged) => (downloadsChanged = listener),
      },
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => undefined),
    },
  });
  mocks.render.mockImplementation(
    async (
      job: ExportJobRequest,
      callbacks: { onFile: (value: ReturnType<typeof file>) => Promise<void> },
    ) => {
      await callbacks.onFile(file(job.id));
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('durable export queue', () => {
  it('acknowledges a persisted enqueue without waiting for rendering', async () => {
    let release!: () => void;
    const rendering = new Promise<void>((resolve) => (release = resolve));
    mocks.render.mockImplementationOnce(async () => rendering);
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');

    await expect(
      handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') }),
    ).resolves.toEqual({ ok: true, id: 'one' });
    expect(mocks.put).toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    release();
  });

  it('does not acknowledge or start a task when durable enqueue storage fails', async () => {
    mocks.put.mockRejectedValueOnce(new Error('database unavailable'));
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await expect(
      handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') }),
    ).resolves.toMatchObject({ ok: false });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('runs tasks serially and records a completed desktop download', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    mocks.render
      .mockImplementationOnce(
        async (
          job: ExportJobRequest,
          callbacks: { onFile: (value: ReturnType<typeof file>) => Promise<void> },
        ) => {
          await first;
          await callbacks.onFile(file(job.id));
        },
      )
      .mockImplementationOnce(
        async (
          job: ExportJobRequest,
          callbacks: { onFile: (value: ReturnType<typeof file>) => Promise<void> },
        ) => {
          await callbacks.onFile(file(job.id));
        },
      );
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('two') });
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
    expect(mocks.render.mock.calls[0]?.[0].id).toBe('one');
    releaseFirst();
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs.map((job) => job.status)).toEqual(['completed', 'completed']);
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(mocks.output).toHaveBeenCalledTimes(2);
    expect(mocks.blobs.size).toBe(0);
  });

  it('cancels a running task and leaves its durable status cancelled', async () => {
    mocks.render.mockImplementationOnce(
      async (_job: ExportJobRequest, callbacks: { signal: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          callbacks.signal.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        });
      },
    );
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    await expect(handleExportJobMessage({ type: 'export-job-cancel', id: 'one' })).resolves.toEqual(
      { ok: true },
    );
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('cancelled');
    });
  });

  it('does not retry or remove until a cancelled renderer has actually stopped', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    mocks.render.mockImplementationOnce(async () => pending);
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    await handleExportJobMessage({ type: 'export-job-cancel', id: 'one' });
    await expect(
      handleExportJobMessage({ type: 'export-job-retry', id: 'one' }),
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      handleExportJobMessage({ type: 'export-job-remove', id: 'one' }),
    ).resolves.toMatchObject({
      ok: false,
    });
    release();
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('cancelled');
    });
  });

  it('does not wait forever for a desktop download when browser cancellation fails', async () => {
    search.mockResolvedValue([{ id: 9, state: 'in_progress' }]);
    cancel.mockRejectedValueOnce(new Error('browser refused cancellation'));
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    await handleExportJobMessage({ type: 'export-job-cancel', id: 'one' });
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('cancelled');
    });
  });

  it('turns a durable callback write failure into a failed task instead of cancellation', async () => {
    let writes = 0;
    mocks.put.mockImplementation(async (job: StoredExportJob) => {
      writes++;
      if (writes === 3) throw new Error('database unavailable');
      mocks.jobs.set(job.id, job);
    });
    mocks.render.mockImplementationOnce(
      async (_job: ExportJobRequest, callbacks: { onProgress: (value: string) => void }) => {
        callbacks.onProgress('rendering');
      },
    );
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('failed');
    });
  });

  it('opens the Android task page and retains a ready Blob without downloads API', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Android 15)' });
    const create = vi.fn(async () => ({}));
    vi.stubGlobal('browser', {
      runtime: { getURL: (path: string) => `moz-extension://test/${path}` },
      tabs: {
        query: vi.fn(async () => []),
        create,
        update: vi.fn(async () => undefined),
      },
    });
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await expect(
      handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') }),
    ).resolves.toEqual({ ok: true, id: 'one' });
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('ready');
      expect(listed.jobs[0]?.files[0]?.saved).toBe(false);
    });
    expect(create).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });

  it('retries only unsaved output without duplicating a completed partial download', async () => {
    mocks.render
      .mockImplementationOnce(
        async (
          job: ExportJobRequest,
          callbacks: { onFile: (value: ReturnType<typeof file>) => Promise<void> },
        ) => {
          await callbacks.onFile(file(job.id));
          throw new Error('second output failed');
        },
      )
      .mockImplementationOnce(
        async (
          job: ExportJobRequest,
          callbacks: { onFile: (value: ReturnType<typeof file>) => Promise<void> },
        ) => {
          await callbacks.onFile(file(job.id));
          await callbacks.onFile({
            ...file(job.id),
            id: `${job.id}:media:2`,
            filename: `${job.id}-2.jpg`,
            output: { tweetId: '42', outputType: 'original-media', filename: `${job.id}-2.jpg` },
          });
        },
      );
    const { handleExportJobMessage } = await import('../src/background/export-jobs.js');
    await handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('failed');
    });
    await expect(handleExportJobMessage({ type: 'export-job-retry', id: 'one' })).resolves.toEqual({
      ok: true,
    });
    await vi.waitFor(async () => {
      const listed = await summaries();
      expect(listed.jobs[0]?.status).toBe('completed');
      expect(listed.jobs[0]?.files).toHaveLength(2);
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(mocks.output).toHaveBeenCalledTimes(2);
  });

  it('marks an in-flight task interrupted after a background restart', async () => {
    const interrupted: StoredExportJob = {
      id: 'old',
      request: request('old'),
      summary: {
        id: 'old',
        kind: 'media',
        tweetId: '42',
        author: 'Alice',
        createdAt: '2026-09-19T00:00:00.000Z',
        status: 'running',
        warnings: [],
        files: [],
        hasDiagnostics: false,
      },
      files: [],
    };
    mocks.jobs.set(interrupted.id, interrupted);
    const { initializeExportJobs } = await import('../src/background/export-jobs.js');
    await initializeExportJobs();
    expect(mocks.jobs.get('old')?.summary.status).toBe('interrupted');
  });
  it('expires Android saved files after 24 hours, unsaved after 7 days, then prunes history', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Firefox Android' });
    const queue = await import('../src/background/export-jobs.js');
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    await queue.handleExportJobMessage({ type: 'export-job-enqueue', request: request('saved') });
    await queue.handleExportJobMessage({ type: 'export-job-enqueue', request: request('unsaved') });
    await vi.waitFor(() => expect(mocks.jobs.get('unsaved')?.summary.status).toBe('ready'));
    await queue.handleExportJobMessage({
      type: 'export-job-file-saved',
      id: 'saved',
      fileId: 'saved:media:1',
    });
    expect(mocks.blobs.size).toBe(2);
    now.mockReturnValue(start + JOB_RETENTION.androidSaved);
    await queue.cleanupExportJobs();
    expect(mocks.blobs.has('saved:media:1')).toBe(false);
    expect(mocks.blobs.has('unsaved:media:1')).toBe(true);
    expect(mocks.jobs.get('saved')?.files[0]).toMatchObject({
      saved: true,
      cached: false,
      size: 5,
    });
    now.mockReturnValue(start + JOB_RETENTION.androidUnsaved);
    await queue.cleanupExportJobs();
    expect(mocks.jobs.get('unsaved')?.summary.status).toBe('expired');
    expect(mocks.blobs.size).toBe(0);
    const result = await queue.handleExportJobMessage({
      type: 'export-job-file',
      id: 'unsaved',
      fileId: 'unsaved:media:1',
    });
    expect(result).toMatchObject({ ok: false });
    now.mockReturnValue(start + JOB_RETENTION.history);
    await queue.cleanupExportJobs();
    expect(mocks.jobs.size).toBe(0);
  });

  it('keeps active work during cleanup and persists expired-file removal only on success', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Firefox Android' });
    const queue = await import('../src/background/export-jobs.js');
    await queue.handleExportJobMessage({ type: 'export-job-enqueue', request: request('old') });
    await vi.waitFor(() => expect(mocks.jobs.get('old')?.summary.status).toBe('ready'));
    const expiry = mocks.jobs.get('old')!.files[0]!.cacheExpiresAt;
    let release!: () => void;
    mocks.render.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await queue.handleExportJobMessage({ type: 'export-job-enqueue', request: request('active') });
    await vi.waitFor(() => expect(mocks.jobs.get('active')?.summary.status).toBe('running'));
    vi.spyOn(Date, 'now').mockReturnValue(expiry + JOB_RETENTION.history);
    mocks.remove.mockRejectedValueOnce(new Error('disk error'));
    await expect(queue.cleanupExportJobs()).rejects.toThrow();
    expect(mocks.blobs.has('old:media:1')).toBe(true);
    expect(mocks.jobs.get('active')?.summary.status).toBe('running');
    await queue.cleanupExportJobs();
    expect(mocks.jobs.has('old')).toBe(false);
    expect(mocks.jobs.has('active')).toBe(true);
    release();
  });

  it('expires diagnostics independently while preserving task metadata', async () => {
    const report: VideoDiagnosticsReport = {
      schemaVersion: 1,
      jobId: 'one',
      tweetId: '42',
      engine: { name: 'ffmpeg.wasm', coreVersion: '0.12.10', threading: 'single', gpu: false },
      startedAt: new Date().toISOString(),
      status: 'completed',
      elapsedMs: 500,
      mediaIndexes: [1],
      frame: 'original',
      style: 'seamless',
      samples: [],
      phaseDurationsMs: {},
      droppedSamples: 0,
      memoryMeasurement: 'wasm-linear-memory-capacity-and-memfs-files-not-process-rss',
    };
    mocks.render.mockImplementationOnce(
      async (
        _job: ExportJobRequest,
        callbacks: { onDiagnostics: (report: VideoDiagnosticsReport) => void },
      ) => {
        callbacks.onDiagnostics(report);
      },
    );
    const queue = await import('../src/background/export-jobs.js');
    await queue.handleExportJobMessage({ type: 'export-job-enqueue', request: request('one') });
    await vi.waitFor(() => expect(mocks.jobs.get('one')?.summary.status).toBe('completed'));
    expect(mocks.jobs.get('one')).not.toHaveProperty('diagnostics');
    expect(mocks.diagnostics.has('one')).toBe(true);
    const deadline = mocks.jobs.get('one')!.diagnosticsExpiresAt!;
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
    await queue.cleanupExportJobs();
    expect(mocks.diagnostics.has('one')).toBe(true);
    now.mockReturnValue(deadline);
    await queue.cleanupExportJobs();
    expect(mocks.diagnostics.has('one')).toBe(false);
    expect(mocks.jobs.get('one')?.summary.hasDiagnostics).toBe(false);
    expect(mocks.jobs.get('one')?.summary.status).toBe('completed');
  });
});
