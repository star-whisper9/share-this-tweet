import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadMedia, isAndroidUserAgent } from '../src/core/download.js';
import type { MediaRecord } from '../src/shared/model.js';
import type { MediaSourceMetadata } from '../src/shared/media-source.js';

const video: MediaRecord = {
  index: 1,
  type: 'video',
  variants: [{ url: 'https://video.twimg.com/test.mp4', mime: 'video/mp4' }],
};
const source: MediaSourceMetadata = {
  schemaVersion: 1,
  platform: 'x',
  tweetId: '42',
  tweetUrl: 'https://x.com/alice/status/42',
  publisher: { id: '7', handle: '@alice', name: 'Alice' },
  media: { index: 1, type: 'video' },
  tool: { name: 'share-this-tweet', version: '0.4.0' },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isAndroidUserAgent', () => {
  it('recognizes Firefox Android user agents', () => {
    expect(
      isAndroidUserAgent('Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0'),
    ).toBe(true);
  });

  it('does not classify desktop Firefox as Android', () => {
    expect(
      isAndroidUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:128.0) Gecko/20100101 Firefox/128.0',
      ),
    ).toBe(false);
  });
});

describe('downloadMedia', () => {
  it('keeps original and sourced desktop requests distinct', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, downloadId: 1 })
      .mockResolvedValueOnce({ ok: true, downloadId: 2 });
    vi.stubGlobal('navigator', { userAgent: 'Firefox desktop' });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    await downloadMedia(video, 'video.mp4');
    await downloadMedia(video, 'video_source.mp4', source);
    expect(sendMessage.mock.calls).toEqual([
      [
        {
          type: 'download-media',
          url: 'https://video.twimg.com/test.mp4',
          filename: 'video.mp4',
        },
      ],
      [
        {
          type: 'download-sourced-media',
          url: 'https://video.twimg.com/test.mp4',
          filename: 'video_source.mp4',
          source,
        },
      ],
    ]);
  });

  it('requests a processed Blob before using the Android anchor path', async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const sendMessage = vi.fn(async () => ({ ok: true, blob }));
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'Firefox Android' });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    vi.stubGlobal('document', {
      body: { append },
      createElement: () => ({ click, remove }),
    });
    vi.stubGlobal('window', { setTimeout: (callback: () => void) => callback() });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await downloadMedia(video, 'video_source.mp4', source);
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'prepare-sourced-media',
      url: 'https://video.twimg.com/test.mp4',
      source,
    });
    expect(append).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});
