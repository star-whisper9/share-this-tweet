import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const pkg = await readJson('package.json');
const manifest = await readJson('src/manifest.json');
const lock = await readJson('package-lock.json');
if (
  pkg.version !== manifest.version ||
  pkg.version !== lock.version ||
  pkg.version !== lock.packages[''].version
) {
  throw new Error('package.json、package-lock.json 与 manifest.json 的版本必须一致。');
}

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
  const source = new JSZip();
  async function add(path) {
    source.file(path, await readFile(join(root, path)));
  }
  async function addDirectory(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /\.local(?:\.|$)/.test(entry.name)) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`源码包不接受符号链接：${child}`);
      if (entry.isDirectory()) await addDirectory(child);
      else if (entry.isFile()) await add(child);
    }
  }
  // Explicit inputs: independent of Git and excludes private local documents.
  for (const directory of ['src', 'scripts', 'tests']) await addDirectory(directory);
  for (const file of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    '.prettierrc.json',
    'LICENSE',
  ])
    await add(file);
  source.file(
    'BUILDING.md',
    `# Build instructions for Mozilla reviewers

Version: ${pkg.version}
Extension ID: ${manifest.browser_specific_settings.gecko.id}
Build environment: ${process.platform} ${process.arch}, Node.js ${process.versions.node}.

Install a supported Node.js release and npm. From this directory run:

    npm ci
    npm run build

The extension is generated in dist/. The submitted ZIP contains the contents of
dist/ with manifest.json at its root, including generated source maps.
TypeScript and esbuild run locally. All image assets are supplied in src/icons/;
no image service or platform-specific image tools are needed. Dependencies are
installed from npm using package-lock.json; no private dependencies are required.

Optional checks: npm run check and npm run lint:extension.
To create both unsigned and source archives: npm run package.
No command in this workflow signs or uploads an extension.
`,
  );
  await writeFile(
    join(output, `${pkg.name}-${pkg.version}-source.zip`),
    await source.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
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
