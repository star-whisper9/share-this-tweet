import { afterEach, expect, it, vi } from 'vitest';
import { readCaptionTracks } from '../src/core/video-captions.js';

const base = 'https://video.twimg.com/test/';
const media = {
  type: 'video' as const,
  index: 1,
  variants: [{ mime: 'application/x-mpegURL', url: base + 'main.m3u8' }],
};
const master =
  '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English, CC",LANGUAGE="en",URI="sub/list.m3u8"';
const cue = '00:00:01.000 --> 00:00:02.000\nhello';
afterEach(() => vi.unstubAllGlobals());
it('resolves nested segment URLs and keeps overlapping cues only once', async () => {
  const files: Record<string, string> = {
    'main.m3u8': master,
    'sub/list.m3u8': '#EXTM3U\na.vtt\nb.vtt',
    'sub/a.vtt': 'WEBVTT\n\n' + cue,
    'sub/b.vtt': 'WEBVTT\n\n' + cue,
  };
  vi.stubGlobal('fetch', async (url: URL) => new Response(files[url.href.slice(base.length)]));
  const tracks = await readCaptionTracks(media, new AbortController().signal);
  expect(tracks).toEqual([
    { name: 'English, CC', language: 'en', text: 'WEBVTT\n\n' + cue + '\n' },
  ]);
});
it('rejects off-origin subtitle URLs before fetching them', async () => {
  const fetch = vi.fn(
    async () => new Response(master.replace('sub/list.m3u8', 'https://example.com/file')),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(readCaptionTracks(media, new AbortController().signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
