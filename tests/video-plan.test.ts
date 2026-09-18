import { expect, it } from 'vitest';
import {
  executeVideoJob,
  parseVideoProbe,
  type VideoCoreAdapter,
} from '../src/core/video-engine.js';
import {
  VideoPlanError,
  createVideoFfmpegArgs,
  createVideoRenderPlan,
} from '../src/core/video-plan.js';

it('plans a source-sized equal-height strip with the first video audio track', () => {
  const plan = createVideoRenderPlan(
    [
      { type: 'photo', probe: { width: 1200, height: 800, duration: 0, hasAudio: false } },
      { type: 'animated_gif', probe: { width: 1600, height: 800, duration: 4, hasAudio: false } },
      { type: 'video', probe: { width: 800, height: 800, duration: 8, hasAudio: true } },
    ],
    'gallery',
  );
  expect(plan.width).toBeGreaterThan(1280);
  expect(plan.height).toBe(800);
  expect(plan.height % 2).toBe(0);
  expect(plan.duration).toBe(8);
  expect(plan.audioInput).toBe(2);
  expect(plan.tiles.map((tile) => tile.height)).toEqual([plan.height, plan.height, plan.height]);
  expect(plan.tiles[1]!.x).toBe(plan.tiles[0]!.width + plan.gap);
  expect(plan.tiles[2]!.x).toBe(plan.tiles[1]!.x + plan.tiles[1]!.width + plan.gap);
});

it('accepts long high-resolution media while rejecting invalid metadata', () => {
  const probe = { width: 9000, height: 4000, duration: 600, hasAudio: true, frameRate: 60 };
  const plan = createVideoRenderPlan([{ type: 'video', probe }], 'seamless');
  expect(plan).toMatchObject({ width: 9000, height: 4000, duration: 600, frameRate: 60 });
  expect(() => createVideoRenderPlan([{ type: 'photo', probe }], 'seamless')).toThrow(
    VideoPlanError,
  );
  expect(() =>
    createVideoRenderPlan([{ type: 'video', probe: { ...probe, width: 0 } }], 'seamless'),
  ).toThrow(VideoPlanError);
  expect(() =>
    createVideoRenderPlan(
      [{ type: 'video', probe: { ...probe, duration: Number.NaN } }],
      'seamless',
    ),
  ).toThrow(VideoPlanError);
});

it('uses looped photos, frozen short dynamics, bounded audio, and h264 mp4 output', () => {
  const plan = createVideoRenderPlan(
    [
      { type: 'photo', probe: { width: 600, height: 400, duration: 0, hasAudio: false } },
      { type: 'video', probe: { width: 600, height: 400, duration: 2, hasAudio: true } },
    ],
    'gallery',
  );
  const args = createVideoFfmpegArgs(
    [
      { path: 'first.image', type: 'photo' },
      { path: 'second.mp4', type: 'video' },
    ],
    plan,
    'gallery',
    '#102030',
    'bottom',
  );
  expect(args).toContain('-loop');
  expect(args).toContain('1');
  expect(args.join(' ')).toContain('tpad=stop_mode=clone');
  expect(args.join(' ')).toContain('setpts=PTS-STARTPTS');
  expect(args.join(' ')).toContain('xstack=inputs=2');
  expect(args.join(' ')).toContain('fill=#102030');
  expect(args.join(' ')).toContain('apad=pad_dur=2.000,atrim=duration=2.000');
  expect(args).toContain('libx264');
  expect(args).toContain('yuv420p');
  expect(args).toContain('output.mp4');
});

it('does not send a single framed video through xstack', () => {
  const plan = createVideoRenderPlan(
    [{ type: 'video', probe: { width: 640, height: 360, duration: 1, hasAudio: false } }],
    'seamless',
  );
  const args = createVideoFfmpegArgs(
    [{ path: 'source.mp4', type: 'video' }],
    plan,
    'seamless',
    '#000000',
    'top',
  );
  expect(args.join(' ')).not.toContain('xstack');
  expect(args.join(' ')).toContain('[1:v][v0]vstack=inputs=2');
});

it('parses ffprobe JSON without treating a still image as a dynamic duration', () => {
  expect(
    parseVideoProbe(
      JSON.stringify({
        streams: [{ codec_type: 'video', width: 320, height: 180 }, { codec_type: 'audio' }],
      }),
    ),
  ).toEqual({ width: 320, height: 180, duration: 0, hasAudio: true });
  expect(() => parseVideoProbe('{not json')).toThrow(VideoPlanError);
  expect(() =>
    parseVideoProbe(
      JSON.stringify({
        streams: [{ codec_type: 'video', width: 320, height: 180, sample_aspect_ratio: '4:3' }],
      }),
    ),
  ).toThrow(VideoPlanError);
});

it('waits for the exact-width PNG frame before encoding and removes job files', async () => {
  const files = new Map<string, Uint8Array>();
  const calls: string[][] = [];
  const probe = (width: number, height: number, duration = 0, audio = false) =>
    JSON.stringify({
      streams: [
        { codec_type: 'video', width, height, ...(duration ? { duration } : {}) },
        ...(audio ? [{ codec_type: 'audio' }] : []),
      ],
      ...(duration ? { format: { duration } } : {}),
    });
  const core: VideoCoreAdapter = {
    writeFile: (path, bytes) => files.set(path, bytes),
    readFile: (path) => files.get(path)!,
    exists: (path) => files.has(path),
    unlink: (path) => files.delete(path),
    exec: (args) => {
      calls.push(args);
      files.set('output.mp4', new Uint8Array([1, 2, 3]));
      return 0;
    },
    ffprobe: (args) => {
      const path = args.at(-1);
      if (path === 'input-0.video.mp4') return { exitCode: 0, output: probe(640, 360, 1, true) };
      if (path === 'frame.png') return { exitCode: 0, output: probe(640, 72) };
      return { exitCode: 1, output: '' };
    },
  };
  const request = {
    type: 'start' as const,
    id: 'video-job',
    inputs: [{ type: 'video' as const, blob: new Blob(['video']) }],
    style: 'seamless' as const,
    background: '#000000' as const,
    frame: 'bottom' as const,
    locale: 'en' as const,
  };
  const result = await executeVideoJob(core, request, {
    onProgress: () => undefined,
    onLayout: async (layout) => {
      expect(layout.width).toBe(640);
      return {
        type: 'frame',
        id: request.id,
        blob: new Blob(['frame'], { type: 'image/png' }),
        height: 72,
      };
    },
  });
  expect(result).toMatchObject({ width: 640, height: 432, duration: 1 });
  expect(result.blob.type).toBe('video/mp4');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.join(' ')).toContain('vstack=inputs=2');
  expect(files.size).toBe(0);
});

it('applies a configured duration limit after probing and before rendering or encoding', async () => {
  const files = new Map<string, Uint8Array>();
  let encoded = false;
  const core: VideoCoreAdapter = {
    writeFile: (path, bytes) => files.set(path, bytes),
    readFile: (path) => files.get(path)!,
    exists: (path) => files.has(path),
    unlink: (path) => files.delete(path),
    exec: () => {
      encoded = true;
      return 0;
    },
    ffprobe: () => ({
      exitCode: 0,
      output: JSON.stringify({
        streams: [{ codec_type: 'video', width: 640, height: 360, duration: 1 }],
        format: { duration: 1 },
      }),
    }),
  };
  const request = {
    type: 'start' as const,
    id: 'limited-video-job',
    inputs: [{ type: 'video' as const, blob: new Blob(['video']) }],
    style: 'seamless' as const,
    background: '#000000' as const,
    frame: 'original' as const,
    locale: 'en' as const,
    limits: {
      maxInputMiB: 0,
      maxDurationSeconds: 0.5,
      maxOutputPixels: 0,
      maxFrameRate: 0,
    },
  };
  await expect(
    executeVideoJob(core, request, {
      onProgress: () => undefined,
      onLayout: async () => {
        throw new Error('frame should not render');
      },
    }),
  ).rejects.toThrow('0.5');
  expect(encoded).toBe(false);
  expect(files.size).toBe(0);
});

it('applies the output-pixel limit again after a source frame is added', async () => {
  const files = new Map<string, Uint8Array>();
  let encoded = false;
  const core: VideoCoreAdapter = {
    writeFile: (path, bytes) => files.set(path, bytes),
    readFile: (path) => files.get(path)!,
    exists: (path) => files.has(path),
    unlink: (path) => files.delete(path),
    exec: () => {
      encoded = true;
      return 0;
    },
    ffprobe: (args) => ({
      exitCode: 0,
      output: JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 640,
            height: args.at(-1) === 'frame.png' ? 72 : 360,
            duration: args.at(-1) === 'frame.png' ? 0 : 1,
          },
        ],
        format: { duration: args.at(-1) === 'frame.png' ? 0 : 1 },
      }),
    }),
  };
  const request = {
    type: 'start' as const,
    id: 'frame-pixel-limit',
    inputs: [{ type: 'video' as const, blob: new Blob(['video']) }],
    style: 'seamless' as const,
    background: '#000000' as const,
    frame: 'bottom' as const,
    locale: 'en' as const,
    limits: {
      maxInputMiB: 0,
      maxDurationSeconds: 0,
      maxOutputPixels: 640 * 400,
      maxFrameRate: 0,
    },
  };
  await expect(
    executeVideoJob(core, request, {
      onProgress: () => undefined,
      onLayout: async () => ({
        type: 'frame',
        id: request.id,
        blob: new Blob(['frame'], { type: 'image/png' }),
        height: 72,
      }),
    }),
  ).rejects.toThrow();
  expect(encoded).toBe(false);
  expect(files.size).toBe(0);
});
