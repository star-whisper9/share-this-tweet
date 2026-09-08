import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { reserveUnlistedVersion } from '../scripts/unlisted-version.mjs';
import { createSourceArchive } from '../scripts/source-archive.mjs';

const directories: string[] = [];
async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'share-unlisted-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('unlisted version reservations', () => {
  it('keeps reservations after a failed attempt and scopes numbers to the base version', async () => {
    const path = await temporaryDirectory();
    const first = await reserveUnlistedVersion(path, '0.3.0');
    await writeFile(join(first.output, 'submission.json'), '{"status":"failed"}');
    expect(first.version).toBe('0.3.0.1');
    expect((await reserveUnlistedVersion(path, '0.3.0')).version).toBe('0.3.0.2');
    expect((await reserveUnlistedVersion(path, '0.3.1')).version).toBe('0.3.1.1');
  });

  it('reserves distinct versions under simultaneous allocation', async () => {
    const path = await temporaryDirectory();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => reserveUnlistedVersion(path, '0.3.0')),
    );
    expect(new Set(results.map((result) => result.version)).size).toBe(4);
    expect((await readdir(path)).sort()).toEqual(['0.3.0.1', '0.3.0.2', '0.3.0.3', '0.3.0.4']);
  });

  it('supports an explicit recovery number and rejects older or duplicate numbers', async () => {
    const path = await temporaryDirectory();
    expect((await reserveUnlistedVersion(path, '0.3.0', '42')).version).toBe('0.3.0.42');
    await expect(reserveUnlistedVersion(path, '0.3.0', '42')).rejects.toThrow();
    await expect(reserveUnlistedVersion(path, '0.3.0', '41')).rejects.toThrow();
    expect((await reserveUnlistedVersion(path, '0.3.0')).version).toBe('0.3.0.43');
  });

  it('rejects unsupported formats and prevents AMO component overflow', async () => {
    const path = await temporaryDirectory();
    for (const base of ['0.3.0.1', '0.3.0-beta', '0.03.0', '0.3', '1000000000.0.0']) {
      await expect(reserveUnlistedVersion(path, base)).rejects.toThrow();
    }
    for (const number of ['0', '-1', '01', '1.5', '1000000000']) {
      await expect(reserveUnlistedVersion(path, '0.3.0', number)).rejects.toThrow();
    }
    expect(await readdir(path)).toEqual([]);
    await reserveUnlistedVersion(path, '0.3.0', '999999999');
    await expect(reserveUnlistedVersion(path, '0.3.0')).rejects.toThrow();
  });
});

it('archives reproducible sources without changing their version or including production assets', async () => {
  const root = await temporaryDirectory();
  for (const dir of ['src', 'scripts', 'tests', 'production']) await mkdir(join(root, dir));
  const files = {
    'package.json': JSON.stringify({ name: 'sample', version: '0.3.0' }),
    'package-lock.json': JSON.stringify({
      version: '0.3.0',
      packages: { '': { version: '0.3.0' } },
    }),
    'src/manifest.json': JSON.stringify({
      version: '0.3.0',
      browser_specific_settings: { gecko: { id: 'sample@example.com' } },
    }),
    'tsconfig.json': '{}',
    'vitest.config.ts': '',
    '.prettierrc.json': '{}',
    LICENSE: '',
    'production/private.txt': 'local only',
    'scripts/private.local.txt': 'local only',
  };
  for (const [path, contents] of Object.entries(files)) await writeFile(join(root, path), contents);
  const archive = join(root, 'source.zip');
  await createSourceArchive(root, archive, '0.3.0.7');
  const zip = await JSZip.loadAsync(await readFile(archive));
  expect(JSON.parse(await zip.file('src/manifest.json')!.async('string')).version).toBe('0.3.0');
  expect(zip.file('production/private.txt')).toBeNull();
  expect(zip.file('scripts/private.local.txt')).toBeNull();
  const instructions = await zip.file('BUILDING.md')!.async('string');
  expect(instructions).toContain('m.version="0.3.0.7"');
  expect(await readFile(join(root, 'src/manifest.json'), 'utf8')).toBe(files['src/manifest.json']);
});
