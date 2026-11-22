import type { MediaRecord } from '../shared/model.js';

export interface CaptionTrack {
  name: string;
  language: string;
  text: string;
}

async function readText(
  path: string,
  base: string,
  signal: AbortSignal,
  budget: { bytes: number },
) {
  const url = new URL(path, base);
  if (url.origin !== 'https://video.twimg.com' || url.username || url.password)
    throw new Error('Unexpected caption URL');
  const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Caption HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      budget.bytes += value.byteLength;
      if (budget.bytes > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Caption data exceeds 16 MiB');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function attributes(line: string) {
  return Object.fromEntries(
    Array.from(line.matchAll(/(?:^|,)([\w-]+)=("[^"]*"|[^,]*)/g), ([, key, value]) => [
      key,
      value!.replace(/^"|"$/g, ''),
    ]),
  );
}

export async function readCaptionTracks(
  media: MediaRecord,
  signal: AbortSignal,
): Promise<CaptionTrack[]> {
  const master = media.variants?.find(
    (v) => /mpegurl/i.test(v.mime) || /\.m3u8(?:\?|$)/i.test(v.url),
  );
  if (!master) return [];
  const budget = { bytes: 0 };
  const read = (url: string, base: string) => readText(url, base, signal, budget);
  const playlist = await read(master.url, master.url);
  if (!playlist.startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  const tracks: CaptionTrack[] = [];
  for (const line of playlist.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attributes(line.slice(13));
    if (a.TYPE !== 'SUBTITLES') continue;
    if (!a.URI || tracks.length >= 32) throw new Error('Invalid HLS subtitle track');
    const uri = new URL(a.URI, master.url).href;
    let text = await read(uri, master.url);
    if (text.startsWith('#EXTM3U')) {
      if (/^#EXT-X-(?:KEY|BYTERANGE|MAP|DISCONTINUITY):?/m.test(text))
        throw new Error('Unsupported subtitle playlist');
      const segments = text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
      if (!segments.length || segments.length > 2048)
        throw new Error('Invalid subtitle segment count');
      const blocks = new Set<string>();
      let timeline: string | undefined;
      for (const segment of segments) {
        const vtt = (await read(segment, uri)).replace(/\r\n?/g, '\n');
        const [header, ...cues] = vtt.trim().split(/\n[ \t]*\n/);
        if (!/^WEBVTT\b/.test(header ?? '')) throw new Error('Invalid WebVTT segment');
        const map = header?.match(/^X-TIMESTAMP-MAP=.*$/m)?.[0] ?? '';
        if (timeline !== undefined && timeline !== map)
          throw new Error('Changing subtitle time base');
        timeline = map;
        for (const cue of cues) if (cue.includes('-->')) blocks.add(cue);
      }
      text = 'WEBVTT\n\n' + [...blocks].join('\n\n') + '\n';
    }
    if (!/^WEBVTT\b/.test(text) || !text.includes('-->'))
      throw new Error('Empty or invalid WebVTT track');
    tracks.push({ name: a.NAME || a.LANGUAGE || 'CC', language: a.LANGUAGE || 'und', text });
  }
  return tracks;
}

export async function muxCaptions(
  video: Blob,
  tracks: CaptionTrack[],
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const worker = new Worker(browser.runtime.getURL('workers/video-render.worker.js'));
  let abort: (() => void) | undefined;
  try {
    return await new Promise<Blob>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessageerror = () => reject(new Error('Invalid subtitle worker response'));
      worker.onmessage = ({ data }) =>
        data.blob instanceof Blob && data.blob.size
          ? resolve(data.blob)
          : reject(new Error(data.error || 'Subtitle mux failed'));
      worker.postMessage({ type: 'mux-captions', video, tracks });
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    worker.terminate();
  }
}
