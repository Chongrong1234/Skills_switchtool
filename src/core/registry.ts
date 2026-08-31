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

/** rename 失败是否值得退避重试(Windows 杀软/索引器瞬时持锁导致的 EPERM 等) */
function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * rename 带退避重试:Windows 上杀毒软件/索引器会瞬时持有文件句柄,
 * 导致 tmp+rename 原子写的最后一步偶发 EPERM,短暂退避后重试即可恢复。
 * 也供 snapshot.ts 的移动操作复用。
 */
export async function renameWithRetry(src: string, dest: string, retries = 3): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (attempt >= retries - 1 || !isRetryableRenameError(err)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** 原子写:先写临时文件再 rename,避免半截写入 */
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await renameWithRetry(tmp, file);
  // 数据文件可能含密钥(ai.json 的 apiKey、mcps.json 的 env token):收窄为仅属主可读写,
  // 对齐各家 CLI 凭据文件惯例。Windows 上 chmod 不映射 NTFS ACL,失败静默忽略。
  await fs.chmod(file, 0o600).catch(() => {});
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

/**
 * 热度统计:把一批 skill 的 useCount +1 并刷新 lastUsedAt(绑定进项目/全局共享时调用)。
 * 只增不减——它表达的是"历史上多常用",解绑不该抹掉热度。
 */
export async function markSkillsUsed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const skills = await readRegistry();
  const now = new Date().toISOString();
  let dirty = false;
  for (const s of skills) {
    if (wanted.has(s.id)) {
      s.useCount = (s.useCount ?? 0) + 1;
      s.lastUsedAt = now;
      dirty = true;
    }
  }
  if (dirty) await writeRegistry(skills);
}
