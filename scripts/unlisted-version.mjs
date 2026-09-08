import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MAX = 999999999;
const BASE_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function validateBaseVersion(baseVersion) {
  if (!BASE_VERSION.test(baseVersion)) {
    throw new Error(`Unlisted 构建要求三段数字基础版本，每段最多九位：${baseVersion}`);
  }
}

export function parseBuildNumber(value) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(value))) {
    throw new Error('build-number 必须是 1–999999999 的整数，不能有前导零。');
  }
  return Number(value);
}

// The version directory is the durable reservation, even after an upload fails.
export async function reserveUnlistedVersion(directory, baseVersion, requested) {
  validateBaseVersion(baseVersion);
  const explicit = requested === undefined ? undefined : parseBuildNumber(requested);
  await mkdir(directory, { recursive: true });
  const prefix = `${baseVersion}.`;
  let maximum = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    if (/^[1-9][0-9]{0,8}$/.test(suffix)) maximum = Math.max(maximum, Number(suffix));
  }
  if (explicit !== undefined && explicit <= maximum) {
    throw new Error(`build-number 必须大于本地已预留编号 ${maximum}。`);
  }
  let number = explicit ?? maximum + 1;
  while (number <= MAX) {
    const version = `${baseVersion}.${number}`;
    const output = join(directory, version);
    try {
      await mkdir(output);
      return { version, output };
    } catch (error) {
      if (error.code !== 'EEXIST' || explicit !== undefined) throw error;
      number += 1;
    }
  }
  throw new Error(`基础版本 ${baseVersion} 的构建编号已用尽，请提升正式版本。`);
}
