import { afterEach, expect, it, vi } from 'vitest';
import {
  enqueueExportJob,
  getExportJobFile,
  clearExportJobCache,
  clearExportJobHistory,
} from '../src/core/job-client.js';
import { isExportJobRequest, type ExportJobRequest } from '../src/shared/export-jobs.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
const job: ExportJobRequest = {
  id: 'one',
  kind: 'media',
  locale: 'en',
  theme: 'light',
  settings: DEFAULT_SETTINGS,
  record: {
    tweetId: '42',
    url: 'https://x.com/a/status/42',
    text: 'text',
    author: { id: '1', name: 'A', handle: 'a' },
    media: [{ index: 1, type: 'photo', originalUrl: 'https://pbs.twimg.com/a.jpg' }],
  },
  media: [{ index: 1, mode: 'original', orientation: 'bottom' }],
};
afterEach(() => vi.unstubAllGlobals());
it('sends explicit cleanup requests and rejects failed or malformed results', async () => {
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, cleared: 2, skipped: 1 })
    .mockResolvedValueOnce({ ok: true, cleared: 3, skipped: 0 })
    .mockResolvedValueOnce({ ok: false, error: 'disk error' })
    .mockResolvedValueOnce({ ok: true, cleared: -1, skipped: 0 });
  vi.stubGlobal('browser', { runtime: { sendMessage } });
  await expect(clearExportJobCache()).resolves.toEqual({ cleared: 2, skipped: 1 });
  await expect(clearExportJobHistory()).resolves.toEqual({ cleared: 3, skipped: 0 });
  expect(sendMessage.mock.calls.slice(0, 2)).toEqual([
    [{ type: 'export-job-clear-cache' }],
    [{ type: 'export-job-clear-history' }],
  ]);
  await expect(clearExportJobCache()).rejects.toThrow();
  await expect(clearExportJobHistory()).rejects.toThrow();
});
it('validates complete snapshots and every fetchable URL including quoted avatars', () => {
  expect(isExportJobRequest(job)).toBe(true);
  expect(
    isExportJobRequest({ ...job, media: [{ index: 99, mode: 'original', orientation: 'bottom' }] }),
  ).toBe(false);
  expect(
    isExportJobRequest({
      ...job,
      record: {
        ...job.record,
        author: { ...job.record.author, avatarUrl: 'https://example.com/private' },
      },
    }),
  ).toBe(false);
  expect(
    isExportJobRequest({
      ...job,
      record: {
        ...job.record,
        quote: {
          status: 'available',
          record: {
            ...job.record,
            author: { ...job.record.author, avatarUrl: 'http://pbs.twimg.com/a.jpg' },
          },
        },
      },
    }),
  ).toBe(false);
});
it('waits for a matching accepted id and rejects bad file responses', async () => {
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, id: 'other' })
    .mockResolvedValueOnce({ ok: true, id: job.id })
    .mockResolvedValueOnce({ ok: true, blob: 'not a blob' });
  vi.stubGlobal('browser', { runtime: { sendMessage } });
  await expect(enqueueExportJob(job)).rejects.toThrow();
  await expect(enqueueExportJob(job)).resolves.toBe('one');
  await expect(getExportJobFile('one', 'file')).rejects.toThrow();
});

it('accepts older queued settings and rejects malformed explicit GIF preferences', () => {
  const { experimentalGif: _enabled, gifLimits: _limits, ...legacySettings } = DEFAULT_SETTINGS;
  expect(isExportJobRequest({ ...job, settings: legacySettings })).toBe(true);
  for (const patch of [
    { experimentalGif: 1 },
    { gifLimits: null },
    { gifLimits: { ...DEFAULT_SETTINGS.gifLimits, maxSourcePixels: -1 } },
  ])
    expect(isExportJobRequest({ ...job, settings: { ...DEFAULT_SETTINGS, ...patch } })).toBe(false);
});

it.each([5, 20])(
  'accepts %i media, single-item exports and quoted media without relaxing URL validation',
  (count) => {
    const media = Array.from({ length: count }, (_, index) => ({
      ...job.record.media[0]!,
      index: index + 1,
    }));
    const record = { ...job.record, media };
    const request = { ...job, record };
    expect(isExportJobRequest(request)).toBe(true);
    expect(isExportJobRequest({ ...request, media: [{ ...job.media![0], index: count }] })).toBe(
      true,
    );
    expect(
      isExportJobRequest({
        ...request,
        media: media.map(({ index }) => ({ ...job.media![0], index })),
      }),
    ).toBe(true);
    for (const kind of ['card', 'row-card', 'stitch'])
      expect(isExportJobRequest({ ...request, kind, frame: 'original' })).toBe(true);
    expect(
      isExportJobRequest({
        ...job,
        record: {
          ...job.record,
          quote: {
            status: 'available',
            tweetId: '43',
            record: { ...record, tweetId: '43' },
          },
        },
      }),
    ).toBe(true);
    const unsafe = { ...media.at(-1)!, originalUrl: 'https://example.com/private' };
    expect(
      isExportJobRequest({
        ...request,
        record: { ...record, media: [...media.slice(0, -1), unsafe] },
      }),
    ).toBe(false);
  },
);
it('rejects excess, out-of-range and duplicate media', () => {
  for (const indexes of [Array.from({ length: 21 }, (_, index) => index + 1), [21], [1, 1]]) {
    expect(
      isExportJobRequest({
        ...job,
        record: {
          ...job.record,
          media: indexes.map((index) => ({ ...job.record.media[0], index })),
        },
      }),
    ).toBe(false);
  }
});
