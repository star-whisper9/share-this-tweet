import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSourceArchive, readReleaseMetadata } from './source-archive.mjs';
import {
  parseBuildNumber,
  reserveUnlistedVersion,
  validateBaseVersion,
} from './unlisted-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    'prepare-only': { type: 'boolean', default: false },
    'build-number': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log('npm run sign:unlisted -- [--prepare-only] [--build-number N]');
  console.log('签名凭据：WEB_EXT_API_KEY / WEB_EXT_API_SECRET；prepare-only 不上传。');
  process.exit(0);
}
const { pkg, manifest } = await readReleaseMetadata(root);
validateBaseVersion(pkg.version);
if (values['build-number'] !== undefined) parseBuildNumber(values['build-number']);
if (!values['prepare-only'] && (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET)) {
  throw new Error('请先设置 WEB_EXT_API_KEY 和 WEB_EXT_API_SECRET；凭据不要写入仓库。');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`命令失败：${command}（${result.signal ?? result.status}）。`);
  }
}
function webExt(args) {
  run(process.execPath, [
    join(root, 'node_modules/web-ext/bin/web-ext.js'),
    ...args,
    '--no-config-discovery',
  ]);
}

const releases = join(root, 'releases.local');
await mkdir(releases, { recursive: true });
const lock = join(releases, 'sign-unlisted.lock');
try {
  await mkdir(lock);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  throw new Error(`已有 unlisted 构建或遗留锁：${lock}。确认没有运行中的任务后再手动移除锁。`);
}
let reservation;
let state;
async function record(status) {
  state = { ...state, status, updatedAt: new Date().toISOString() };
  await writeFile(
    join(reservation.output, 'submission.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}
try {
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  run('npm', ['run', 'check']);
  reservation = await reserveUnlistedVersion(
    join(releases, 'unlisted'),
    pkg.version,
    values['build-number'],
  );
  state = {
    version: reservation.version,
    sourceVersion: pkg.version,
    extensionId: manifest.browser_specific_settings.gecko.id,
    channel: 'unlisted',
  };
  await record('preparing');
  console.log(`Unlisted 版本：${reservation.version}\n产物目录：${reservation.output}`);
  const sourceDir = join(reservation.output, 'extension');
  await cp(join(root, 'dist'), sourceDir, { recursive: true });
  const manifestPath = join(sourceDir, 'manifest.json');
  const signedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  signedManifest.version = reservation.version;
  await writeFile(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`);
  webExt(['lint', '--source-dir', sourceDir, '--warnings-as-errors']);
  const sourceArchive = join(reservation.output, `${pkg.name}-${reservation.version}-source.zip`);
  await createSourceArchive(root, sourceArchive, reservation.version);
  webExt([
    'build',
    '--source-dir',
    sourceDir,
    '--artifacts-dir',
    reservation.output,
    '--filename',
    `${pkg.name}-${reservation.version}-unsigned.zip`,
  ]);
  await record('prepared');
  if (values['prepare-only']) {
    console.log('已准备并校验，未上传。此编号已预留，下次会使用新编号。');
  } else {
    await record('submitting');
    webExt([
      'sign',
      '--channel',
      'unlisted',
      '--source-dir',
      sourceDir,
      '--artifacts-dir',
      reservation.output,
      '--upload-source-code',
      sourceArchive,
    ]);
    const artifacts = await readdir(reservation.output);
    if (!artifacts.some((name) => name.endsWith('.xpi'))) {
      throw new Error('签名命令结束但未取得 XPI，请检查 AMO 提交状态；本地编号继续保留。');
    }
    await record('signed');
    console.log(`签名完成：${reservation.output}`);
  }
} catch (error) {
  if (reservation) {
    await record('failed');
    console.error(`失败记录和产物保留于 ${reservation.output}；版本号不会回收。`);
  }
  throw error;
} finally {
  await rm(lock, { recursive: true });
}
