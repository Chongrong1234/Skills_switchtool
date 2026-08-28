/**
 * ~/.skills-switch/ 目录骨架的路径常量。
 * 每次调用都重新读取 SSW_HOME 环境变量,便于测试用临时目录隔离。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 状态根目录:SSW_HOME 环境变量优先,否则 ~/.skills-switch */
export function sswHome(): string {
  return process.env.SSW_HOME || path.join(os.homedir(), '.skills-switch');
}

export function libraryDir(): string {
  return path.join(sswHome(), 'library');
}

export function registryFile(): string {
  return path.join(sswHome(), 'registry.json');
}

export function projectsFile(): string {
  return path.join(sswHome(), 'projects.json');
}

export function snapshotsDir(): string {
  return path.join(sswHome(), 'snapshots');
}

export function cacheDir(): string {
  return path.join(sswHome(), 'cache');
}

/** 启动时确保目录骨架存在 */
export async function ensureSkeleton(): Promise<void> {
  for (const dir of [sswHome(), libraryDir(), snapshotsDir(), cacheDir()]) {
    await fs.mkdir(dir, { recursive: true });
  }
}
