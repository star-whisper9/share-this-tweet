import { expect, it, vi } from 'vitest';
import { createGifRenderPlan } from '../src/core/gif-plan.js';
import { executeVideoJob, type VideoCoreAdapter } from '../src/core/video-engine.js';
import { GifLimitError } from '../src/shared/gif-experiment.js';

it('scales the GIF quality preset without upscaling or raising low frame rates', () => {
  expect(
    createGifRenderPlan({ width: 1920, height: 1080, duration: 3, frameRate: 60, hasAudio: false }),
  ).toMatchObject({ width: 960, height: 540, duration: 3, frameRate: 20 });
  expect(
    createGifRenderPlan({ width: 240, height: 480, duration: 3, frameRate: 10, hasAudio: false }),
  ).toMatchObject({ width: 240, height: 480, frameRate: 10 });
});

it('uses two passes, releases temporary files, and distinguishes limits from encoder failures', async () => {
  const request = {
    type: 'start' as const,
    id: 'gif',
    inputs: [{ type: 'animated_gif' as const, blob: new Blob(['mp4']) }],
    style: 'seamless' as const,
    background: '#000000' as const,
    frame: 'original' as const,
    locale: 'en' as const,
    outputFormat: 'gif' as const,
    limits: { maxInputMiB: 64, maxDurationSeconds: 60, maxOutputPixels: 8294400, maxFrameRate: 0 },
  };
  const files = new Map<string, Uint8Array>();
  let failEncode = false;
  let duration = 3;
  const core: VideoCoreAdapter = {
    writeFile: (path, bytes) => {
      files.set(path, bytes);
    },
    readFile: (path) => files.get(path)!,
    exists: (path) => files.has(path),
    unlink: (path) => {
      files.delete(path);
    },
    ffprobe: () => ({
      exitCode: 0,
      output: JSON.stringify({
        streams: [
          { codec_type: 'video', width: 1920, height: 1080, duration, avg_frame_rate: '60/1' },
        ],
      }),
    }),
    exec: vi.fn((args: string[]) => {
      if (failEncode && args.at(-1) === 'output.gif') return 1;
      files.set(args.at(-1)!, new TextEncoder().encode('GIF89a'));
      return 0;
    }),
  };
  const callbacks = {
    onProgress: vi.fn(),
    onLayout: async () => ({ type: 'frame' as const, id: request.id }),
  };
  const result = await executeVideoJob(core, request, callbacks);
  expect(result).toMatchObject({ width: 960, height: 540, duration: 3 });
  expect(result.blob.type).toBe('image/gif');
  expect(vi.mocked(core.exec).mock.calls.map(([args]) => args.at(-1))).toEqual([
    'palette.png',
    'output.gif',
  ]);
  expect(vi.mocked(core.exec).mock.calls[0][0]).toContain('0:v:0');
  expect(files.size).toBe(0);
  failEncode = true;
  await expect(executeVideoJob(core, request, callbacks)).rejects.not.toBeInstanceOf(GifLimitError);
  expect(files.size).toBe(0);
  duration = 61;
  vi.mocked(core.exec).mockClear();
  await expect(executeVideoJob(core, request, callbacks)).rejects.toBeInstanceOf(GifLimitError);
  expect(core.exec).not.toHaveBeenCalled();
  expect(files.size).toBe(0);
});
