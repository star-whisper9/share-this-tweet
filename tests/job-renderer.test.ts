import { afterEach, expect, it, vi } from 'vitest';
import { renderExportJob } from '../src/core/job-renderer.js';
import { renderVideoInBackground } from '../src/background/video-render.js';
import { renderPhotoFrame } from '../src/core/frame.js';
import { embedMp4SourceInWorker } from '../src/core/media-source-client.js';
import { renderStitchedMedia } from '../src/core/stitch.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { ExportJobRequest } from '../src/shared/export-jobs.js';

vi.mock('../src/background/video-render.js', () => ({ renderVideoInBackground: vi.fn() }));
vi.mock('../src/core/stitch.js', async (original) => ({
  ...(await original<typeof import('../src/core/stitch.js')>()),
  renderStitchedMedia: vi.fn(),
}));
vi.mock('../src/core/frame.js', async (original) => ({
  ...(await original<typeof import('../src/core/frame.js')>()),
  renderPhotoFrame: vi.fn(),
}));
vi.mock('../src/core/media-source-client.js', () => ({ embedMp4SourceInWorker: vi.fn() }));

const request: ExportJobRequest = {
  id: 'job-one',
  kind: 'media',
  locale: 'en',
  theme: 'light',
  settings: { ...DEFAULT_SETTINGS },
  record: {
    tweetId: '42',
    url: 'https://x.com/a/status/42',
    text: '',
    author: { id: '1', name: 'A', handle: 'a' },
    media: [
      { index: 1, type: 'photo', originalUrl: 'https://pbs.twimg.com/a?format=jpg' },
      { index: 2, type: 'photo', originalUrl: 'https://pbs.twimg.com/b?format=jpg' },
    ],
  },
  media: [
    { index: 1, mode: 'original', orientation: 'bottom' },
    { index: 2, mode: 'original', orientation: 'bottom' },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('emits one original-media file per selected media item', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  const files: Array<{ filename: string; mediaIndex?: number }> = [];
  await renderExportJob(request, {
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onWarning: vi.fn(),
    onDiagnostics: vi.fn(),
    onFile: async (file) =>
      files.push({ filename: file.filename, mediaIndex: file.output.mediaIndex }),
  });
  expect(files.map((file) => file.mediaIndex)).toEqual([1, 2]);
  expect(files.every((file) => file.filename.endsWith('.jpg'))).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not start a cancelled job or emit a file', async () => {
  const controller = new AbortController();
  controller.abort();
  const onFile = vi.fn();
  await expect(
    renderExportJob(request, {
      signal: controller.signal,
      onProgress: vi.fn(),
      onWarning: vi.fn(),
      onDiagnostics: vi.fn(),
      onFile,
    }),
  ).rejects.toThrow();
  expect(onFile).not.toHaveBeenCalled();
});

it('does not emit a file when cancellation arrives during a media download', async () => {
  let completeFetch: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          completeFetch = resolve;
        }),
    ),
  );
  const controller = new AbortController();
  const onFile = vi.fn();
  const rendering = renderExportJob(request, {
    signal: controller.signal,
    onProgress: vi.fn(),
    onWarning: vi.fn(),
    onDiagnostics: vi.fn(),
    onFile,
  });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  controller.abort();
  completeFetch!(new Response(new Uint8Array([1, 2, 3])));
  await expect(rendering).rejects.toThrow();
  expect(onFile).not.toHaveBeenCalled();
});

it('continues a media batch after one item fails, then reports the batch failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]))),
  );
  const files: number[] = [];
  await expect(
    renderExportJob(request, {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onWarning: vi.fn(),
      onDiagnostics: vi.fn(),
      onFile: async (file) => files.push(file.output.mediaIndex!),
    }),
  ).rejects.toThrow();
  expect(files).toEqual([2]);
});

it('adds source metadata to a fetched video before emitting it', async () => {
  vi.stubGlobal('browser', { runtime: { getManifest: () => ({ version: '0.5.0' }) } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  const output = new Blob(['sourced'], { type: 'video/mp4' });
  vi.mocked(embedMp4SourceInWorker).mockResolvedValueOnce(output);
  const video: ExportJobRequest = {
    ...request,
    media: [{ index: 1, mode: 'sourced', orientation: 'bottom' }],
    record: {
      ...request.record,
      media: [
        {
          index: 1,
          type: 'video',
          variants: [{ mime: 'video/mp4', url: 'https://video.twimg.com/video.mp4' }],
        },
      ],
    },
  };
  const files: Array<{ outputType: string; blob: Blob }> = [];
  await renderExportJob(video, {
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onWarning: vi.fn(),
    onDiagnostics: vi.fn(),
    onFile: async (file) => files.push({ outputType: file.output.outputType, blob: file.blob }),
  });
  expect(embedMp4SourceInWorker).toHaveBeenCalledOnce();
  expect(files).toEqual([{ outputType: 'sourced-media', blob: output }]);
});

it('renders a framed photo before emitting it', async () => {
  const framed = new Blob(['frame'], { type: 'image/jpeg' });
  vi.mocked(renderPhotoFrame).mockResolvedValueOnce(framed);
  const files: string[] = [];
  await renderExportJob(
    { ...request, media: [{ index: 1, mode: 'framed', orientation: 'top' }] },
    {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onWarning: vi.fn(),
      onDiagnostics: vi.fn(),
      onFile: async (file) => files.push(file.output.outputType),
    },
  );
  expect(renderPhotoFrame).toHaveBeenCalledOnce();
  expect(files).toEqual(['framed-image']);
});

it('saves a static stitch before reporting an animated-limit fallback', async () => {
  vi.stubGlobal('browser', { runtime: { getManifest: () => ({ version: '0.5.0' }) } });
  vi.mocked(renderVideoInBackground).mockResolvedValueOnce({ type: 'fallback', reason: 'limit' });
  vi.mocked(renderStitchedMedia).mockResolvedValueOnce(new Blob(['stitch'], { type: 'image/png' }));
  const events: string[] = [];
  await renderExportJob(
    {
      ...request,
      kind: 'stitch',
      frame: 'original',
      settings: { ...request.settings, experimentalVideo: true },
      record: {
        ...request.record,
        media: [
          request.record.media[0]!,
          {
            index: 2,
            type: 'animated_gif',
            previewUrl: 'https://pbs.twimg.com/preview?format=jpg',
            variants: [{ mime: 'video/mp4', url: 'https://video.twimg.com/video.mp4' }],
          },
        ],
      },
    },
    {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onDiagnostics: vi.fn(),
      onFile: async () => events.push('file'),
      onWarning: () => events.push('warning'),
    },
  );
  expect(events).toEqual(['file', 'warning']);
  expect(renderStitchedMedia).toHaveBeenCalledOnce();
});

it('uses a static stitch for mixed media while the experiment is disabled', async () => {
  vi.mocked(renderStitchedMedia).mockResolvedValueOnce(new Blob(['stitch'], { type: 'image/png' }));
  const files: string[] = [];
  await renderExportJob(
    {
      ...request,
      kind: 'stitch',
      frame: 'original',
      record: {
        ...request.record,
        media: [
          request.record.media[0]!,
          {
            index: 2,
            type: 'video',
            previewUrl: 'https://pbs.twimg.com/preview?format=jpg',
            variants: [{ mime: 'video/mp4', url: 'https://video.twimg.com/video.mp4' }],
          },
        ],
      },
    },
    {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onDiagnostics: vi.fn(),
      onWarning: vi.fn(),
      onFile: async (file) => files.push(file.output.outputType),
    },
  );
  expect(renderVideoInBackground).not.toHaveBeenCalled();
  expect(files).toEqual(['stitched-image']);
});

it('uses the already downloaded dynamic source when a frame crosses a limit', async () => {
  vi.stubGlobal('browser', { runtime: { getManifest: () => ({ version: '0.5.0' }) } });
  const source = new Blob(['mp4'], { type: 'video/mp4' });
  vi.mocked(renderVideoInBackground).mockResolvedValueOnce({
    type: 'fallback',
    reason: 'limit',
    blob: source,
  });
  const events: string[] = [];
  await renderExportJob(
    {
      ...request,
      media: [{ index: 1, mode: 'framed', orientation: 'bottom' }],
      settings: { ...request.settings, experimentalVideo: true },
      record: {
        ...request.record,
        media: [
          {
            index: 1,
            type: 'video',
            variants: [{ mime: 'video/mp4', url: 'https://video.twimg.com/video.mp4' }],
          },
        ],
      },
    },
    {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onDiagnostics: vi.fn(),
      onFile: async (file) => {
        expect(file.blob).toBe(source);
        expect(file.output.outputType).toBe('original-media');
        events.push('file');
      },
      onWarning: () => events.push('warning'),
    },
  );
  expect(events).toEqual(['file', 'warning']);
});
