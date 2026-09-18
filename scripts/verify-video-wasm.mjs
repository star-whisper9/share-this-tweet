// Exercises the built Worker and real WASM, then inspects output with native ffprobe.
// This is not a Firefox integration or mobile performance test.
import { Worker } from 'node:worker_threads';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import crc32 from 'jszip/lib/crc32.js';
import assert from 'node:assert/strict';

function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * (width * 3 + 1) + 1 + x * 3;
      pixels[p] = 32;
      pixels[p + 1] = 80 + (x % 64);
      pixels[p + 2] = 160;
    }
  function chunk(type, data) {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([size, name, data, checksum]);
  }
  return new Blob(
    [
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(pixels)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    ],
    { type: 'image/png' },
  );
}
const directory = await mkdtemp(join(tmpdir(), 'stt-video-wasm-'));
const clip = new Blob([await readFile('tests/fixtures/source-media.mp4')], { type: 'video/mp4' });
const cases = [
  {
    name: 'mixed-seamless',
    inputs: [
      { type: 'photo', blob: png(32, 32) },
      { type: 'video', blob: clip },
    ],
    frame: 'original',
    style: 'seamless',
    audio: true,
  },
  {
    name: 'gif-gallery-bottom',
    inputs: [
      { type: 'photo', blob: png(32, 32) },
      { type: 'animated_gif', blob: clip },
    ],
    frame: 'bottom',
    style: 'gallery',
    audio: false,
  },
  {
    name: 'video-top',
    inputs: [{ type: 'video', blob: clip }],
    frame: 'top',
    style: 'seamless',
    audio: true,
  },
  {
    name: 'video-bottom',
    inputs: [{ type: 'video', blob: clip }],
    frame: 'bottom',
    style: 'seamless',
    audio: true,
  },
];
try {
  for (const job of cases) {
    const started = performance.now();
    const worker = new Worker(new URL('./video-worker-harness.mjs', import.meta.url), {
      workerData: { dist: resolve('dist') },
    });
    let layout;
    try {
      const result = await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('WASM smoke test timed out')), 60_000);
        const finish = (error, value) => {
          clearTimeout(timer);
          error ? fail(error) : done(value);
        };
        worker.on('error', (error) => finish(error));
        worker.on('message', (message) => {
          if (message.type === 'layout') {
            layout = message;
            worker.postMessage(
              job.frame === 'original'
                ? { type: 'frame', id: job.name }
                : { type: 'frame', id: job.name, blob: png(message.width, 32), height: 32 },
            );
          } else if (message.type === 'done') finish(undefined, message);
          else if (message.type === 'error') finish(new Error(message.error));
        });
        worker.postMessage({
          type: 'start',
          id: job.name,
          inputs: job.inputs,
          style: job.style,
          frame: job.frame,
          background: '#111820',
          locale: 'en',
        });
      });
      const output = join(directory, `${job.name}.mp4`);
      await writeFile(output, new Uint8Array(await result.blob.arrayBuffer()));
      const check = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
          '-of',
          'json',
          output,
        ],
        { encoding: 'utf8' },
      );
      if (check.error) throw check.error;
      assert.equal(check.status, 0, check.stderr);
      const probe = JSON.parse(check.stdout);
      const video = probe.streams.find((stream) => stream.codec_type === 'video');
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.width, layout.width);
      assert.equal(video.height, layout.height + (job.frame === 'original' ? 0 : 32));
      assert.equal(video.r_frame_rate, '24/1');
      assert.equal(
        probe.streams.some((stream) => stream.codec_type === 'audio'),
        job.audio,
      );
      assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.1);
      console.log(
        `${job.name}: ${video.width}x${video.height}, ${probe.format.duration}s, audio=${job.audio}, ${result.blob.size} bytes, ${Math.round(performance.now() - started)}ms`,
      );
    } finally {
      await worker.terminate();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
