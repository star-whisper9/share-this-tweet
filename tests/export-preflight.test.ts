import { expect, it } from 'vitest';
import { exportLimitWarnings } from '../src/core/export-preflight.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { ExportJobRequest } from '../src/shared/export-jobs.js';
const request: ExportJobRequest = {
  id: 'preflight',
  kind: 'stitch',
  frame: 'original',
  locale: 'en',
  theme: 'light',
  settings: { ...DEFAULT_SETTINGS, experimentalVideo: true },
  record: {
    tweetId: '42',
    url: 'https://x.com/a/status/42',
    text: '',
    author: { id: '1', name: 'A', handle: 'a' },
    media: [1, 2].map((index) => ({ index, type: 'photo', width: 14000, height: 1000 })),
  },
};
const measure = (text: string, size: number) => (text.length * size) / 2;
it('predicts oversized collages without downloads and skips budgets for a forced request', () => {
  expect(exportLimitWarnings(request, measure)).toHaveLength(1);
  expect(exportLimitWarnings({ ...request, force: true }, measure)).toEqual([]);
  expect(
    exportLimitWarnings(
      {
        ...request,
        record: {
          ...request.record,
          media: request.record.media.map((item) => ({ ...item, width: undefined })),
        },
      },
      measure,
    ),
  ).toEqual([]);
});
it('checks framed media but leaves original downloads unrestricted', () => {
  const framed = {
    ...request,
    kind: 'media' as const,
    media: [{ index: 1, mode: 'framed' as const, orientation: 'bottom' as const }],
    record: { ...request.record, media: [{ ...request.record.media[0]!, width: 20000 }] },
  };
  expect(exportLimitWarnings(framed, measure).length).toBeGreaterThan(0);
  expect(
    exportLimitWarnings({ ...framed, media: [{ ...framed.media[0]!, mode: 'original' }] }, measure),
  ).toEqual([]);
});
it('checks video duration and output pixels using each job’s captured preferences', () => {
  const job = {
    ...request,
    record: {
      ...request.record,
      media: [{ index: 1, type: 'video' as const, width: 4000, height: 3000, durationMs: 181000 }],
    },
  };
  expect(exportLimitWarnings(job, measure)).toHaveLength(2);
  expect(
    exportLimitWarnings(
      {
        ...job,
        settings: {
          ...job.settings,
          videoLimits: {
            maxInputMiB: 0,
            maxDurationSeconds: 0,
            maxOutputPixels: 0,
            maxFrameRate: 0,
          },
        },
      },
      measure,
    ),
  ).toEqual([]);
});
it('estimates long cards without changing their layout width cap', () => {
  const job = {
    ...request,
    kind: 'card' as const,
    record: { ...request.record, text: 'line\n'.repeat(300), media: [] },
  };
  expect(exportLimitWarnings(job, measure)).toHaveLength(1);
});

it('warns about a large source even when the resulting video strip would be small', () => {
  const job = {
    ...request,
    record: {
      ...request.record,
      media: [
        { index: 1, type: 'photo' as const, width: 10000, height: 10000 },
        { index: 2, type: 'video' as const, width: 100, height: 100, durationMs: 1000 },
      ],
    },
  };
  expect(exportLimitWarnings(job, measure)).toHaveLength(1);
});
