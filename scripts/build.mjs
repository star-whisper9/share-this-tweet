import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entries = [
  ['src/background/background.ts', 'background/background.js'],
  ['src/content/bootstrap.ts', 'content/bootstrap.js'],
  ['src/page/interceptor.ts', 'page/interceptor.js'],
  ['src/options/options.ts', 'options/options.js'],
  ['src/popup/popup.ts', 'popup/popup.js'],
  ['src/tasks/tasks.ts', 'tasks/tasks.js'],
  ['src/workers/media-source.worker.ts', 'workers/media-source.worker.js'],
  ['src/workers/video-render.worker.ts', 'workers/video-render.worker.js'],
];

for (const [source, output] of entries) {
  await build({
    entryPoints: [resolve(root, source)],
    outfile: resolve(dist, output),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'firefox115',
    sourcemap: true,
    legalComments: 'eof',
  });
}

await cp(resolve(root, 'src/manifest.json'), resolve(dist, 'manifest.json'));
await cp(resolve(root, 'src/_locales'), resolve(dist, '_locales'), { recursive: true });
await mkdir(resolve(dist, 'icons'), { recursive: true });
for (const icon of ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-96.png', 'icon-128.png']) {
  await cp(resolve(root, 'src/icons', icon), resolve(dist, 'icons', icon));
}
for (const icon of ['x.svg', 'x.png']) {
  try {
    await cp(resolve(root, 'src/icons', icon), resolve(dist, 'icons', icon));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
await cp(resolve(root, 'src/icons/grok.svg'), resolve(dist, 'icons/grok.svg'));
await cp(resolve(root, 'src/styles'), resolve(dist, 'styles'), { recursive: true });
await cp(resolve(root, 'src/options/options.html'), resolve(dist, 'options/options.html'));
await cp(resolve(root, 'src/options/options.css'), resolve(dist, 'options/options.css'));
await cp(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup/popup.html'));
await cp(resolve(root, 'src/popup/popup.css'), resolve(dist, 'popup/popup.css'));

// Single-thread FFmpeg is loaded only when a dynamic export starts.
await mkdir(resolve(dist, 'vendor/ffmpeg'), { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp(
    resolve(root, 'node_modules/@ffmpeg/core/dist/umd', name),
    resolve(dist, 'vendor/ffmpeg', name),
  );
}

await cp(resolve(root, 'src/vendor/ffmpeg'), resolve(dist, 'vendor/ffmpeg'), { recursive: true });

await cp(resolve(root, 'src/tasks/tasks.html'), resolve(dist, 'tasks/tasks.html'));
await cp(resolve(root, 'src/tasks/tasks.css'), resolve(dist, 'tasks/tasks.css'));
