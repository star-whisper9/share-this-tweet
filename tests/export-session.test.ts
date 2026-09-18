import { renderDynamicMedia } from '../src/core/video-client.js';
import { setLocale } from '../src/shared/i18n.js';
import { renderStitchedMedia } from '../src/core/stitch.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportSession } from '../src/content/export-session.js';
import { detectCardTheme, renderTweetCard } from '../src/core/card.js';
import { renderPhotoFrame } from '../src/core/frame.js';
import { downloadBlob, downloadMedia } from '../src/core/download.js';
import { recordOutput, saveTweetRecord } from '../src/core/storage-client.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { MediaRecord, TweetRecord } from '../src/shared/model.js';

vi.mock('../src/core/card.js', () => ({
  renderTweetCard: vi.fn(),
  detectCardTheme: vi.fn(() => 'light'),
}));
vi.mock('../src/core/frame.js', async (original) => ({
  ...(await original<typeof import('../src/core/frame.js')>()),
  renderPhotoFrame: vi.fn(),
}));
vi.mock('../src/core/video-client.js', () => ({ renderDynamicMedia: vi.fn() }));
vi.mock('../src/core/stitch.js', () => ({ renderStitchedMedia: vi.fn() }));
vi.mock('../src/core/download.js', () => ({ downloadBlob: vi.fn(), downloadMedia: vi.fn() }));
vi.mock('../src/core/storage-client.js', () => ({
  recordOutput: vi.fn(),
  saveTweetRecord: vi.fn(),
}));

const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/alice/status/42',
  text: 'body',
  author: { id: '7', name: 'Alice', handle: 'alice' },
  media: [],
};
const settings = { ...DEFAULT_SETTINGS, filenameTemplate: '{tweet.id}_{media.index}.{extension}' };
const png = new Blob(['png'], { type: 'image/png' });
const photo = (index: number): MediaRecord => ({
  index,
  type: 'photo',
  originalUrl: `https://pbs.twimg.com/media/${index}.jpg`,
});
const video: MediaRecord = {
  index: 2,
  type: 'video',
  variants: [{ url: 'https://video.twimg.com/test.mp4', mime: 'video/mp4' }],
};
function mixedSession(onChange?: () => void): ExportSession {
  const session = new ExportSession(
    { ...record, media: [photo(1), video, photo(3)] },
    settings,
    onChange,
  );
  session.toggleMedia(2);
  session.toggleMedia(3);
  return session;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('browser', { runtime: { getManifest: () => ({ version: '0.4.0' }) } });
  vi.mocked(renderTweetCard).mockResolvedValue({ blob: png, width: 1600, height: 500 });
  vi.mocked(renderDynamicMedia).mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }));
  vi.mocked(renderPhotoFrame).mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
  vi.mocked(detectCardTheme).mockReturnValue('light');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setLocale('zh-CN');
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('export session', () => {
  it('saves a mixed selection with independently configured photo and video formats', async () => {
    const session = mixedSession();
    session.configureMedia({ photo: 'top', video: 'sourced' });
    await session.saveSelected('configured');
    expect(renderPhotoFrame).toHaveBeenCalledTimes(2);
    expect(vi.mocked(renderPhotoFrame).mock.calls.every((call) => call[3] === 'top')).toBe(true);
    expect(downloadMedia).toHaveBeenCalledWith(
      video,
      '42_2_source.mp4',
      expect.objectContaining({ media: { index: 2, type: 'video' } }),
    );
    expect(vi.mocked(recordOutput).mock.calls.map(([output]) => output.outputType)).toEqual([
      'framed-image',
      'sourced-media',
      'framed-image',
    ]);
    expect(session.mediaAction('configured').status).toBe('success');
    session.configureMedia({ photo: 'original', video: 'original' });
    expect(session.mediaAction('configured').status).toBe('idle');
    await session.saveSelected('configured');
    expect(
      vi
        .mocked(downloadMedia)
        .mock.calls.slice(-3)
        .every((call) => call[2] === undefined),
    ).toBe(true);
    expect(renderPhotoFrame).toHaveBeenCalledTimes(2);
  });

  it('keeps the configured format and selection fixed during a single media download', async () => {
    const pendingDownload = deferred<void>();
    vi.mocked(downloadMedia).mockReturnValueOnce(pendingDownload.promise);
    const session = new ExportSession({ ...record, media: [video] }, settings);
    const pending = session.saveSelected('configured');
    session.configureMedia({ video: 'original' });
    session.toggleMedia(video.index);
    await session.saveSelected('configured');
    expect(session.mediaOptions.video).toBe('sourced');
    expect(session.selection.has(video.index)).toBe(true);
    expect(downloadMedia).toHaveBeenCalledOnce();
    pendingDownload.resolve();
    await pending;
    expect(session.isSavingBatch).toBe(false);
    session.configureMedia({ video: 'original' });
    expect(session.mediaOptions.video).toBe('original');
  });

  it('reuses a text-only card while recording each save', async () => {
    const session = new ExportSession(record, settings);
    await session.saveCard();
    await session.saveCard();
    const file = vi.mocked(downloadBlob).mock.calls[0][0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/png');
    expect(renderTweetCard).toHaveBeenCalledOnce();
    expect(renderTweetCard).toHaveBeenCalledWith(
      record,
      [],
      expect.objectContaining({ theme: 'light' }),
    );
    expect(downloadBlob).toHaveBeenCalledTimes(2);
    expect(saveTweetRecord).toHaveBeenCalledWith(record);
    const outputs = vi.mocked(recordOutput).mock.calls.map(([output]) => output);
    expect(outputs.map(({ outputType }) => outputType)).toEqual(['tweet-card', 'tweet-card']);
    for (const output of outputs) {
      expect(output.tweetId).toBe(record.tweetId);
      expect(output.filename).toBe((file as File).name);
      expect(output.mediaIndex).toBeUndefined();
    }
  });

  it('passes all media to card rendering and records the first media identity', async () => {
    const media = [video, photo(3)];
    const withMedia = { ...record, media };
    const session = new ExportSession(withMedia, settings);
    await session.saveCard();
    expect(renderTweetCard).toHaveBeenCalledWith(
      withMedia,
      media,
      expect.objectContaining({ theme: 'light' }),
    );
    expect(recordOutput).toHaveBeenCalledWith(
      expect.objectContaining({ outputType: 'tweet-card', mediaIndex: 2 }),
    );
  });

  it('suppresses duplicate clicks and stale completion after the session is disposed', async () => {
    const generation = deferred<Awaited<ReturnType<typeof renderTweetCard>>>();
    vi.mocked(renderTweetCard).mockReturnValue(generation.promise);
    const changed = vi.fn();
    const session = new ExportSession(record, settings, changed);
    const pending = session.saveCard();
    expect(renderTweetCard).toHaveBeenCalledOnce();
    session.dispose();
    changed.mockClear();
    generation.resolve({ blob: png, width: 1600, height: 500 });
    await pending;
    expect(recordOutput).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('continues a mixed batch after one failure and records only completed outputs', async () => {
    const session = mixedSession();
    vi.mocked(renderDynamicMedia).mockRejectedValueOnce(new Error());
    await session.saveSelected('framed', 'top');
    expect(renderPhotoFrame).toHaveBeenCalledTimes(2);
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(renderDynamicMedia).toHaveBeenCalledOnce();
    expect(downloadBlob).toHaveBeenCalledTimes(2);
    const outputs = vi.mocked(recordOutput).mock.calls.map(([output]) => output);
    expect(outputs.map(({ mediaIndex }) => mediaIndex)).toEqual([1, 3]);
    expect(outputs.every(({ outputType }) => outputType === 'framed-image')).toBe(true);
    expect(session.mediaAction('framed', 'top').status).toBe('error');
    expect(session.isSavingBatch).toBe(false);
    // Incremental responses do not reselect media deliberately deselected by the user.
    for (const index of [1, 2, 3]) session.toggleMedia(index);
    session.updateRecord({ ...record, media: [photo(1), video, photo(3)] });
    await session.saveSelected('original');
    expect(session.selection.size).toBe(0);
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(renderDynamicMedia).toHaveBeenCalledOnce();
  });

  it('does not save an in-flight frame or start later batch items after disposal', async () => {
    const rendering = deferred<Blob>();
    vi.mocked(renderPhotoFrame).mockReturnValue(rendering.promise);
    const session = mixedSession();
    const pending = session.saveSelected('framed', 'bottom');
    expect(session.isSavingBatch).toBe(true);
    session.dispose();
    rendering.resolve(png);
    await pending;
    expect(renderPhotoFrame).toHaveBeenCalledOnce();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(recordOutput).not.toHaveBeenCalled();
  });

  it('suppresses concurrent saves and invalidates changed card inputs', async () => {
    const generation = deferred<Awaited<ReturnType<typeof renderTweetCard>>>();
    vi.mocked(renderTweetCard).mockReturnValueOnce(generation.promise);
    const session = new ExportSession(record, settings);
    const save = session.saveCard();
    const duplicate = session.saveCard();
    expect(renderTweetCard).toHaveBeenCalledOnce();
    generation.resolve({ blob: png, width: 100, height: 100 });
    await Promise.all([save, duplicate]);
    session.updateRecord({ ...record, text: 'updated' });
    await session.saveCard();
    vi.mocked(detectCardTheme).mockReturnValue('dark');
    await session.saveCard();
    session.updateSettings({ ...settings, filenameTemplate: 'changed_{tweet.id}.{extension}' });
    await session.saveCard();
    expect(renderTweetCard).toHaveBeenCalledTimes(4);
    expect(vi.mocked(downloadBlob).mock.calls.at(-1)![1]).toBe('changed_42_card.png');
  });

  it('uses the actual transparent frame format for the downloaded filename', async () => {
    vi.mocked(renderPhotoFrame).mockResolvedValue(new Blob(['webp'], { type: 'image/webp' }));
    const session = new ExportSession({ ...record, media: [photo(1)] }, settings);
    await session.saveSelected('framed');
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('42_1_framed.webp');
  });

  it('reports storage failure separately from an already completed output', async () => {
    vi.mocked(recordOutput).mockRejectedValueOnce(new Error());
    const session = new ExportSession(record, settings);
    await session.saveCard();
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(session.action('save-card').status).toBe('success');
    expect(session.status.state).toBe('error');
  });

  it('writes source only to dynamic media in a mixed batch and records actual output types', async () => {
    const session = mixedSession();
    await session.saveSelected('sourced');
    const calls = vi.mocked(downloadMedia).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[1]?.[1]).toBe('42_2_source.mp4');
    expect(calls[1]?.[2]).toMatchObject({
      schemaVersion: 1,
      tweetId: '42',
      media: { index: 2, type: 'video' },
      tool: { name: 'share-this-tweet', version: '0.4.0' },
    });
    expect(calls[2]?.[2]).toBeUndefined();
    expect(vi.mocked(recordOutput).mock.calls.map(([output]) => output.outputType)).toEqual([
      'original-media',
      'sourced-media',
      'original-media',
    ]);
  });

  it('does not silently fall back to an original download when source writing fails', async () => {
    vi.mocked(downloadMedia).mockRejectedValueOnce(new Error('unsupported MP4'));
    const session = new ExportSession({ ...record, media: [video] }, settings);
    await session.saveSelected('sourced');
    expect(downloadMedia).toHaveBeenCalledOnce();
    expect(downloadMedia).toHaveBeenCalledWith(
      video,
      '42_2_source.mp4',
      expect.objectContaining({ tweetId: '42' }),
    );
    expect(recordOutput).not.toHaveBeenCalled();
    expect(session.mediaAction('sourced').status).toBe('error');
  });
});

it('exports quote media with its own identity and cancels child work with the parent', async () => {
  const quoted = {
    ...record,
    tweetId: '99',
    url: 'https://x.com/bob/status/99',
    author: { id: '8', name: 'Bob', handle: 'bob' },
    media: [photo(1)],
  };
  const parent = new ExportSession(
    {
      ...record,
      media: [photo(1)],
      quote: { tweetId: '99', url: quoted.url, status: 'available', record: quoted },
    },
    settings,
  );
  await parent.quoted!.saveSelected('framed');
  expect(vi.mocked(recordOutput).mock.calls[0][0].tweetId).toBe('99');
  expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('99_1_framed.jpg');
  expect(parent.selection.size).toBe(1);
  parent.quoted!.toggleMedia(1);
  expect(parent.selection.size).toBe(1);
  parent.dispose();
  await parent.quoted!.saveSelected('original');
  expect(downloadMedia).not.toHaveBeenCalled();
});

it('stitches all photos independently of selection and records a single output', async () => {
  vi.mocked(renderStitchedMedia).mockResolvedValue(png);
  const session = new ExportSession(
    { ...record, media: [photo(1), photo(2), photo(3)] },
    { ...settings, stitchStyle: 'gallery' },
  );
  session.toggleMedia(1);
  expect(session.selection.size).toBe(0);
  await session.stitchMedia();
  expect(renderStitchedMedia).toHaveBeenCalledWith(
    session.record,
    expect.objectContaining({ stitchStyle: 'gallery' }),
    'light',
    expect.anything(),
    settings.frameOrientation,
    'zh-CN',
  );
  expect(downloadBlob).toHaveBeenCalledOnce();
  expect(recordOutput).toHaveBeenCalledWith(
    expect.objectContaining({ outputType: 'stitched-image' }),
  );
  vi.mocked(renderStitchedMedia).mockRejectedValueOnce(new Error('preview unavailable'));
  await session.stitchMedia();
  expect(session.action('stitch-media').status).toBe('error');
  expect(downloadBlob).toHaveBeenCalledOnce();
});

it('separates grid and row card caches and refreshes the row style after settings change', async () => {
  const session = new ExportSession({ ...record, media: [photo(1), photo(2)] }, settings);
  await session.saveCard();
  await session.saveCard(true);
  await session.saveCard(true);
  expect(renderTweetCard).toHaveBeenCalledTimes(2);
  expect(renderTweetCard).toHaveBeenLastCalledWith(
    session.record,
    session.record.media,
    expect.objectContaining({ mediaLayout: 'row', stitchStyle: 'seamless' }),
  );
  session.updateSettings({ ...settings, stitchStyle: 'gallery' });
  await session.saveCard(true);
  expect(renderTweetCard).toHaveBeenCalledTimes(3);
  expect(renderTweetCard).toHaveBeenLastCalledWith(
    session.record,
    session.record.media,
    expect.objectContaining({ mediaLayout: 'row', stitchStyle: 'gallery' }),
  );
  const names = vi.mocked(downloadBlob).mock.calls.map((call) => call[1]);
  expect(names[0]).not.toEqual(names[1]);
  expect(vi.mocked(recordOutput).mock.calls.map(([output]) => output.outputType)).toEqual([
    'tweet-card',
    'row-tweet-card',
    'row-tweet-card',
    'row-tweet-card',
  ]);
});

it.each(['original', 'top', 'bottom'] as const)(
  'captures the current %s frame choice for stitching',
  async (frame) => {
    const pending = deferred<Blob>();
    vi.mocked(renderStitchedMedia).mockReturnValueOnce(pending.promise);
    const session = new ExportSession({ ...record, media: [photo(1), photo(2)] }, settings);
    session.configureMedia({ photo: frame });
    const work = session.stitchMedia();
    session.configureMedia({ photo: frame === 'top' ? 'bottom' : 'top' });
    await session.stitchMedia();
    expect(renderStitchedMedia).toHaveBeenCalledOnce();
    expect(renderStitchedMedia).toHaveBeenCalledWith(
      session.record,
      settings,
      'light',
      expect.anything(),
      frame,
      'zh-CN',
    );
    pending.resolve(
      new Blob(['image'], { type: frame === 'original' ? 'image/png' : 'image/jpeg' }),
    );
    await work;
    const filename = vi.mocked(downloadBlob).mock.calls[0][1];
    expect(filename.endsWith(frame === 'original' ? '_stitched.png' : '_stitched_framed.jpg')).toBe(
      true,
    );
  },
);

it('captures the export language and does not reuse a card from another language', async () => {
  const pending = deferred<{ blob: Blob; width: number; height: number }>();
  vi.mocked(renderTweetCard).mockReturnValueOnce(pending.promise);
  const session = new ExportSession(record, settings);
  setLocale('en');
  const work = session.saveCard();
  setLocale('zh-CN');
  expect(renderTweetCard).toHaveBeenCalledWith(
    record,
    record.media,
    expect.objectContaining({ locale: 'en' }),
  );
  pending.resolve({ blob: png, width: 1600, height: 500 });
  await work;
  await session.saveCard();
  expect(renderTweetCard).toHaveBeenCalledTimes(2);
  expect(renderTweetCard).toHaveBeenLastCalledWith(
    record,
    record.media,
    expect.objectContaining({ locale: 'zh-CN' }),
  );
});

it('exports mixed stitching as MP4 while card previews remain static', async () => {
  const session = mixedSession();
  session.configureMedia({ photo: 'top' });
  await session.stitchMedia();
  expect(renderDynamicMedia).toHaveBeenCalledWith(
    session.record,
    session.record.media,
    settings,
    'top',
    'light',
    'zh-CN',
    expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }),
  );
  expect(renderStitchedMedia).not.toHaveBeenCalled();
  expect(downloadBlob).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'video/mp4' }),
    '42_1_stitched_framed.mp4',
  );
  expect(recordOutput).toHaveBeenCalledWith(
    expect.objectContaining({ outputType: 'stitched-video' }),
  );
  await session.saveCard();
  expect(renderTweetCard).toHaveBeenCalledOnce();
});
it('keeps photo and video frame directions independent in a mixed save', async () => {
  const session = mixedSession();
  session.configureMedia({ photo: 'top', video: 'bottom' });
  await session.saveSelected('configured');
  expect(vi.mocked(renderPhotoFrame).mock.calls.every((call) => call[3] === 'top')).toBe(true);
  expect(renderDynamicMedia).toHaveBeenCalledWith(
    session.record,
    [video],
    settings,
    'bottom',
    'light',
    'zh-CN',
    expect.anything(),
  );
  expect(vi.mocked(recordOutput).mock.calls.map(([output]) => output.outputType)).toEqual([
    'framed-image',
    'framed-video',
    'framed-image',
  ]);
  expect(downloadMedia).not.toHaveBeenCalled();
});
it('cancels an in-flight video without downloading or starting later batch items', async () => {
  vi.mocked(renderDynamicMedia).mockImplementation(
    (_record, _media, _settings, _frame, _theme, _locale, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      ),
  );
  const session = new ExportSession(
    { ...record, media: [video, { ...video, index: 3 }] },
    settings,
  );
  session.toggleMedia(3);
  session.configureMedia({ video: 'top' });
  const work = session.saveSelected('configured');
  expect(session.isProcessingVideo).toBe(true);
  session.cancelMediaProcessing();
  await work;
  expect(session.isProcessingVideo).toBe(false);
  expect(renderDynamicMedia).toHaveBeenCalledOnce();
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(recordOutput).not.toHaveBeenCalled();
  expect(session.mediaAction('configured').status).toBe('error');
});
