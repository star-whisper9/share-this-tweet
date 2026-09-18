// Node harness for the packaged browser Worker. No network access is used.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { runInThisContext } from 'node:vm';
const dist = workerData.dist;
function assetPath(value) {
  const url = new URL(value);
  if (url.origin !== 'https://extension.invalid') throw new Error('Unexpected worker asset origin');
  const path = resolve(dist, `.${url.pathname}`);
  if (!path.startsWith(dist + sep)) throw new Error('Unexpected worker asset path');
  return path;
}
globalThis.self = globalThis;
globalThis.location = { href: 'https://extension.invalid/workers/video-render.worker.js' };
globalThis.importScripts = (...urls) => {
  for (const url of urls) runInThisContext(readFileSync(assetPath(url), 'utf8'), { filename: url });
};
globalThis.fetch = async (url) =>
  new Response(readFileSync(assetPath(url)), { headers: { 'content-type': 'application/wasm' } });
globalThis.postMessage = (message) => parentPort.postMessage(message);
runInThisContext(readFileSync(resolve(dist, 'workers/video-render.worker.js'), 'utf8'), {
  filename: 'video-render.worker.js',
});
parentPort.on('message', (data) => globalThis.onmessage({ data }));
