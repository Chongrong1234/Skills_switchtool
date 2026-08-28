/**
 * skills 注册表(registry.json)读写。
 * 写入采用 tmp + rename 原子写;读取时 JSON 损坏则容错为空注册表。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { registryFile } from './paths.js';
import type { SkillEntry } from './types.js';

interface RegistryData {
  skills: SkillEntry[];
}

/** 原子写:先写临时文件再 rename,避免半截写入 */
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 容错读取 JSON 文件;不存在或损坏时返回 fallback */
export async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export async function readRegistry(): Promise<SkillEntry[]> {
  const data = await readJsonSafe<RegistryData>(registryFile(), { skills: [] });
  return Array.isArray(data.skills) ? data.skills : [];
}

export async function writeRegistry(skills: SkillEntry[]): Promise<void> {
  await atomicWriteJson(registryFile(), { skills });
}

export async function getSkill(id: string): Promise<SkillEntry | undefined> {
  const skills = await readRegistry();
  return skills.find((s) => s.id === id);
}

/** 新增或覆盖(按 id)一条 skill 记录 */
export async function upsertSkill(entry: SkillEntry): Promise<void> {
  const skills = await readRegistry();
  const idx = skills.findIndex((s) => s.id === entry.id);
  if (idx >= 0) skills[idx] = entry;
  else skills.push(entry);
  await writeRegistry(skills);
}

export async function removeSkill(id: string): Promise<boolean> {
  const skills = await readRegistry();
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  await writeRegistry(next);
  return true;
}
