import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_JOBS_DATABASE_NAME,
  EXPORT_JOBS_STORE,
  putExportJob,
  getExportJob,
  listExportJobs,
  getExportJobBlob,
  getExportJobDiagnostics,
  deleteExportJob,
  type StoredExportJob,
} from '../src/core/job-store.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { JOB_RETENTION } from '../src/shared/job-retention.js';
import type { VideoDiagnosticsReport } from '../src/core/video-report.js';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { userAgent: 'Firefox Desktop' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const report: VideoDiagnosticsReport = {
  schemaVersion: 1,
  jobId: 'one',
  tweetId: '42',
  engine: { name: 'ffmpeg.wasm', coreVersion: '0.12.10', threading: 'single', gpu: false },
  startedAt: '2026-09-19T00:00:00Z',
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
function job(id = 'one'): StoredExportJob {
  return {
    id,
    request: {
      id,
      kind: 'media',
      theme: 'light',
      locale: 'en',
      settings: { ...DEFAULT_SETTINGS },
      record: {
        tweetId: '42',
        text: 'hello',
        url: 'https://x.com/alice/status/42',
        author: { id: '1', name: 'Alice', handle: 'alice' },
        media: [],
      },
    },
    summary: {
      id,
      kind: 'media',
      tweetId: '42',
      author: 'Alice',
      createdAt: new Date().toISOString(),
      status: 'ready',
      warnings: [],
      files: [],
      hasDiagnostics: true,
    },
    files: [
      {
        id: `${id}:media:1`,
        filename: 'one.mp4',
        size: 5,
        saved: false,
        cached: true,
        cacheExpiresAt: Date.now() + JOB_RETENTION.androidUnsaved,
        output: { tweetId: '42', outputType: 'original-media', filename: 'one.mp4' },
      },
    ],
  };
}
async function seedLegacy(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(EXPORT_JOBS_DATABASE_NAME, 1);
    opening.onupgradeneeded = () =>
      opening.result.createObjectStore(EXPORT_JOBS_STORE, { keyPath: 'id' });
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const tx = database.transaction(EXPORT_JOBS_STORE, 'readwrite');
      tx.objectStore(EXPORT_JOBS_STORE).put(value);
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => {
        database.close();
        reject(tx.error);
      };
    };
  });
}
describe('separated export payload storage', () => {
  it('stores metadata without payloads and deletes only the selected task with its payloads', async () => {
    const one = job(),
      two = job('two');
    await putExportJob(one, {
      files: [{ id: one.files[0]!.id, blob: new Blob(['video']) }],
      diagnostics: report,
    });
    await putExportJob(two, { files: [{ id: two.files[0]!.id, blob: new Blob(['other']) }] });
    expect(await getExportJob('one')).not.toHaveProperty('diagnostics');
    expect((await listExportJobs())[0]?.files[0]).not.toHaveProperty('blob');
    expect(await (await getExportJobBlob(one.files[0]!.id))?.text()).toBe('video');
    expect(await getExportJobDiagnostics('one')).toMatchObject({ elapsedMs: 500 });
    // Progress-only writes must leave large payloads untouched.
    one.summary.progress = 'encoding';
    await putExportJob(one);
    expect(await getExportJobDiagnostics('one')).toMatchObject({ elapsedMs: 500 });
    await deleteExportJob('one');
    expect(await getExportJobBlob(one.files[0]!.id)).toBeUndefined();
    expect(await getExportJobDiagnostics('one')).toBeUndefined();
    expect(await getExportJob('one')).toBeUndefined();
    expect(await (await getExportJobBlob(two.files[0]!.id))?.text()).toBe('other');
  });

  it.each([false, true])(
    'migrates embedded v1 blobs and diagnostics without resetting saved flags (Android=%s)',
    async (android) => {
      if (android) vi.stubGlobal('navigator', { userAgent: 'Firefox Android' });
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const old = job();
      await seedLegacy({
        ...old,
        diagnostics: report,
        files: [
          { ...old.files[0], saved: false, blob: new Blob(['video']) },
          { ...old.files[0], id: 'one:media:2', saved: true, blob: new Blob(['saved']) },
        ],
      });
      const migrated = await getExportJob('one');
      expect(migrated?.files.map((file) => file.saved)).toEqual([false, true]);
      expect(migrated?.files.map((file) => file.cached)).toEqual([true, android]);
      expect(migrated?.files[0]).not.toHaveProperty('blob');
      expect(migrated).not.toHaveProperty('diagnostics');
      expect(await (await getExportJobBlob('one:media:1'))?.text()).toBe('video');
      expect((await getExportJobBlob('one:media:2'))?.size).toBe(android ? 5 : undefined);
      expect(await getExportJobDiagnostics('one')).toMatchObject({ elapsedMs: 500 });
      expect(migrated?.files[0]?.cacheExpiresAt).toBe(
        now + (android ? JOB_RETENTION.androidUnsaved : JOB_RETENTION.desktopUnsaved),
      );
    },
  );

  it('rolls back payload deletion when the shared transaction aborts', async () => {
    const value = job();
    await putExportJob(value, { files: [{ id: value.files[0]!.id, blob: new Blob(['video']) }] });
    await expect(
      putExportJob(
        { ...value, files: [] },
        {
          removeFileIds: [value.files[0]!.id],
          diagnostics: Object.assign({}, report, { invalidValue: () => undefined }),
        },
      ),
    ).rejects.toThrow();
    expect(await getExportJob('one')).toBeDefined();
    expect(await (await getExportJobBlob(value.files[0]!.id))?.text()).toBe('video');
  });
});
