import { describe, expect, it } from 'vitest';
import { fileCounts, filterJobs, pendingFiles } from '../src/shared/job-list.js';
import type { JobSummary } from '../src/shared/export-jobs.js';

const now = new Date(2026, 8, 22, 12).getTime();
function job(id: string, createdAt = new Date(now).toISOString()): JobSummary {
  return {
    id,
    createdAt,
    kind: 'media',
    tweetId: '42',
    author: 'Alice',
    status: 'ready',
    warnings: [],
    hasDiagnostics: false,
    files: [
      {
        id: `${id}:1`,
        filename: 'one.jpg',
        size: 5,
        saved: false,
        cached: true,
        cacheExpiresAt: now + 1000,
      },
    ],
  };
}
const all = { storage: 'all', from: '', to: '' } as const;

describe('task listing and batch selection', () => {
  it('sorts newest first regardless of insertion order with a deterministic tie-breaker', () => {
    const old = job('old', new Date(now - 10000).toISOString());
    for (const input of [
      [old, job('b'), job('a')],
      [job('a'), job('b'), old],
    ]) {
      expect(filterJobs(input, all, now).map((item) => item.id)).toEqual(['b', 'a', 'old']);
    }
  });
  it('filters inclusive local calendar dates, not UTC dates or time-of-day cutoffs', () => {
    const start = job('start', new Date(2026, 8, 21, 0, 0).toISOString());
    const end = job('end', new Date(2026, 8, 22, 23, 59).toISOString());
    const outside = job('outside', new Date(2026, 8, 23, 0, 0).toISOString());
    expect(
      filterJobs([start, end, outside], { ...all, from: '2026-09-21', to: '2026-09-22' }, now).map(
        (item) => item.id,
      ),
    ).toEqual(['end', 'start']);
  });
  it('distinguishes saved, pending and expired files within partial tasks', () => {
    const mixed = job('mixed');
    mixed.files.push({ ...mixed.files[0], id: 'saved', saved: true, cached: false });
    mixed.files.push({ ...mixed.files[0], id: 'expired', cacheExpiresAt: now });
    expect(fileCounts(mixed, now)).toEqual({ saved: 1, pending: 1, unavailable: 1 });
    expect(filterJobs([mixed], { ...all, storage: 'pending' }, now)).toHaveLength(1);
    expect(filterJobs([mixed], { ...all, storage: 'unavailable' }, now)).toHaveLength(1);
    expect(filterJobs([mixed], { ...all, storage: 'saved' }, now)).toHaveLength(0);
  });
  it('batch selects only unsaved cached unexpired files outside active tasks', () => {
    const ready = job('ready');
    const running = { ...job('running'), status: 'running' as const };
    const queued = { ...job('queued'), status: 'queued' as const };
    const saved = job('saved');
    saved.files[0].saved = true;
    const expired = job('expired');
    expired.files[0].cacheExpiresAt = now;
    const released = job('released');
    released.files[0].cached = false;
    expect(pendingFiles([ready, running, queued, saved, expired, released], now)).toEqual([
      { jobId: 'ready', fileId: 'ready:1' },
    ]);
    expect(
      filterJobs([running, queued, ready], { ...all, storage: 'processing' }, now),
    ).toHaveLength(2);
  });
});
