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
  vi.mocked(renderTweetCard).mockResolvedValue({ blob: png, width: 1600, height: 500 });
  vi.mocked(renderPhotoFrame).mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
  vi.mocked(detectCardTheme).mockReturnValue('light');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('export session', () => {
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
    vi.mocked(downloadMedia).mockRejectedValueOnce(new Error());
    await session.saveSelected('framed', 'top');
    expect(renderPhotoFrame).toHaveBeenCalledTimes(2);
    expect(downloadMedia).toHaveBeenCalledOnce();
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
    expect(downloadMedia).toHaveBeenCalledOnce();
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
