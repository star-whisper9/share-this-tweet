import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportSession } from '../src/content/export-session.js';
import { enqueueExportJob, openExportJobs } from '../src/core/job-client.js';
import { copyTweetText } from '../src/core/text-export.js';
import { saveTweetRecord, recordOutput } from '../src/core/storage-client.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { setLocale } from '../src/shared/i18n.js';
import type { TweetRecord } from '../src/shared/model.js';
vi.mock('../src/core/job-client.js', () => ({
  enqueueExportJob: vi.fn(async (job) => job.id),
  openExportJobs: vi.fn(async () => {}),
}));
vi.mock('../src/core/card.js', () => ({ detectCardTheme: vi.fn(() => 'dark') }));
vi.mock('../src/core/text-export.js', async (original) => ({
  ...(await original<typeof import('../src/core/text-export.js')>()),
  copyTweetText: vi.fn(async () => {}),
}));
vi.mock('../src/core/storage-client.js', () => ({
  saveTweetRecord: vi.fn(async () => {}),
  recordOutput: vi.fn(async () => {}),
}));
const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/a/status/42',
  text: 'body',
  author: { id: '1', name: 'A', handle: 'a' },
  media: [
    { index: 1, type: 'photo', originalUrl: 'https://pbs.twimg.com/media/a.jpg' },
    {
      index: 2,
      type: 'video',
      variants: [{ url: 'https://video.twimg.com/a.mp4', mime: 'video/mp4' }],
    },
  ],
};
const settings = { ...DEFAULT_SETTINGS, experimentalVideo: true };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enqueueExportJob).mockImplementation(async (job) => job.id);
});
afterEach(() => {
  setLocale('zh-CN');
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: (s: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}
it('submits the whole selection with independent frame modes and an immutable snapshot', async () => {
  const session = new ExportSession(structuredClone(record), structuredClone(settings));
  session.toggleMedia(2);
  session.configureMedia({ photo: 'top', video: 'bottom' });
  await session.saveSelected('configured');
  const job = vi.mocked(enqueueExportJob).mock.calls[0]![0];
  expect(job).toMatchObject({
    kind: 'media',
    theme: 'dark',
    media: [
      { index: 1, mode: 'framed', orientation: 'top' },
      { index: 2, mode: 'framed', orientation: 'bottom' },
    ],
  });
  session.record.author.name = 'Changed';
  session.settings.frameTemplate = 'changed';
  expect(job.record.author.name).toBe('A');
  expect(job.settings.frameTemplate).toBe(settings.frameTemplate);
  expect(session.mediaAction('configured')).toMatchObject({ status: 'success', queued: true });
  expect(recordOutput).not.toHaveBeenCalled();
});
it('submits before disposal, suppresses duplicate submissions and never cancels accepted work', async () => {
  const pending = deferred();
  vi.mocked(enqueueExportJob).mockReturnValueOnce(pending.promise);
  const changed = vi.fn();
  const session = new ExportSession(record, settings, changed);
  const task = session.saveSelected('original');
  await session.saveSelected('original');
  expect(enqueueExportJob).toHaveBeenCalledOnce();
  session.dispose();
  const count = changed.mock.calls.length;
  pending.resolve('accepted');
  await task;
  expect(changed).toHaveBeenCalledTimes(count);
  expect(enqueueExportJob).toHaveBeenCalledOnce();
});
it('only marks queued after acknowledgement and reports a rejected submission', async () => {
  const pending = deferred();
  vi.mocked(enqueueExportJob).mockReturnValueOnce(pending.promise);
  const session = new ExportSession(record, settings);
  const task = session.stitchMedia();
  expect(session.action('stitch-media').status).toBe('loading');
  pending.resolve('accepted');
  await task;
  expect(session.action('stitch-media').queued).toBe(true);
  vi.mocked(enqueueExportJob).mockRejectedValueOnce(new Error('storage failed'));
  await session.stitchMedia();
  expect(session.action('stitch-media').status).toBe('error');
});
it('stitches all media independently of selection and captures locale and frame', async () => {
  const session = new ExportSession(record, settings);
  session.toggleMedia(1);
  session.configureMedia({ photo: 'original' });
  setLocale('en');
  await session.stitchMedia();
  expect(enqueueExportJob).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'stitch',
      frame: 'original',
      locale: 'en',
      record: expect.objectContaining({ media: record.media }),
    }),
  );
});
it('queues cards including quotes and submits quote downloads with their own identity', async () => {
  const quote = { ...record, tweetId: '43', url: 'https://x.com/a/status/43' };
  const session = new ExportSession(
    { ...record, quote: { status: 'available', record: quote } },
    settings,
  );
  await session.saveCard();
  await session.saveCard(true);
  await session.quoted!.saveSelected('original');
  expect(vi.mocked(enqueueExportJob).mock.calls.map(([j]) => [j.kind, j.record.tweetId])).toEqual([
    ['card', '42'],
    ['row-card', '42'],
    ['media', '43'],
  ]);
  expect(vi.mocked(enqueueExportJob).mock.calls[0]![0].record.quote?.record?.tweetId).toBe('43');
});
it('keeps text copy local and records it after success', async () => {
  const session = new ExportSession(record, settings);
  await session.copyText();
  expect(copyTweetText).toHaveBeenCalledWith(record, settings.textTemplate, 'zh-CN');
  expect(recordOutput).toHaveBeenCalledWith({ tweetId: '42', outputType: 'copied-text' });
  expect(enqueueExportJob).not.toHaveBeenCalled();
  expect(saveTweetRecord).toHaveBeenCalled();
});
it('clears disabled dynamic frame choices and opens the independent task page', async () => {
  const session = new ExportSession(record, settings);
  session.configureMedia({ video: 'top' });
  session.updateSettings({ ...settings, experimentalVideo: false });
  expect(session.mediaOptions.video).toBe('sourced');
  await session.openTasks();
  expect(openExportJobs).toHaveBeenCalledOnce();
});
