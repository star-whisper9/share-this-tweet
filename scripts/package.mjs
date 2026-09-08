import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceArchive, readReleaseMetadata } from './source-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { pkg } = await readReleaseMetadata(root);

function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} 执行失败（${result.status}）。`);
}

const artifacts = join(root, 'releases.local');
await mkdir(artifacts, { recursive: true });
// Each run has its own directory so existing submissions are never overwritten.
const output = await mkdtemp(join(artifacts, `${pkg.version}-`));
try {
  await createSourceArchive(
    root,
    join(output, `${pkg.name}-${pkg.version}-source.zip`),
    pkg.version,
  );
  run('node_modules/web-ext/bin/web-ext.js', [
    'build',
    '--source-dir',
    'dist',
    '--artifacts-dir',
    output,
    '--filename',
    `${pkg.name}-${pkg.version}-unsigned.zip`,
    '--no-config-discovery',
  ]);
  console.log(`\n上传 AMO：${join(output, `${pkg.name}-${pkg.version}-unsigned.zip`)}`);
  console.log(`审核源码：${join(output, `${pkg.name}-${pkg.version}-source.zip`)}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
