import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';

export async function readReleaseMetadata(root) {
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
  return { pkg, manifest };
}

export async function createSourceArchive(root, output, version) {
  const { pkg, manifest } = await readReleaseMetadata(root);
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
  for (const directory of ['src', 'scripts', 'tests']) await addDirectory(directory);
  for (const file of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    '.prettierrc.json',
    'LICENSE',
  ]) {
    await add(file);
  }
  const override =
    version === pkg.version
      ? ''
      : `\nThis unlisted build changes only dist/manifest.json version after the build.\nRun this command to reproduce the submitted manifest:\n\n    node --input-type=module -e 'import fs from "node:fs"; const p="dist/manifest.json"; const m=JSON.parse(fs.readFileSync(p,"utf8")); m.version=${JSON.stringify(version)}; fs.writeFileSync(p,JSON.stringify(m,null,2)+"\\n");'\n`;
  source.file(
    'BUILDING.md',
    `# Build instructions for Mozilla reviewers

Version: ${version}
Source version: ${pkg.version}
Extension ID: ${manifest.browser_specific_settings.gecko.id}
Build environment: ${process.platform} ${process.arch}, Node.js ${process.versions.node}.

Install a supported Node.js release and npm. From this directory run:

    npm ci
    npm run build
${override}
The extension is generated in dist/. The submitted ZIP contains the contents of
dist/ with manifest.json at its root, including generated source maps.
TypeScript and esbuild run locally. All image assets are supplied in src/icons/;
no image service or platform-specific image tools are needed. Dependencies are
installed from npm using package-lock.json; no private dependencies are required.

Optional checks: npm run check and npm run lint:extension.
To create both unsigned and source archives: npm run package.
Those commands do not sign or upload an extension. Do not run sign:unlisted to reproduce a build.
`,
  );
  await writeFile(
    output,
    await source.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
}
