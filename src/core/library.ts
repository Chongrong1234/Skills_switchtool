/**
 * 中央库:安装(github→git clone --depth 1 / local→复制)、卸载、更新、自建脚手架。
 * 库是唯一事实来源,所有 skill 实体都存放在 ~/.skills-switch/library/ 下。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { libraryDir } from './paths.js';
import { getSkill, readRegistry, removeSkill, upsertSkill } from './registry.js';
import type { SkillEntry } from './types.js';

const execFileP = promisify(execFile);

export class LibraryError extends Error {}

/** 解析 SKILL.md 的 YAML frontmatter(仅支持单行 key: value,够用即可) */
export function parseFrontmatter(content: string): Record<string, string> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 校验一个目录是否是合法 skill:SKILL.md 存在且 frontmatter 的 name/description 非空。
 * 返回 { name, description } 或抛出 LibraryError。
 */
export async function validateSkillDir(dir: string): Promise<{ name: string; description: string }> {
  let content: string;
  try {
    content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    throw new LibraryError(`缺少 SKILL.md: ${dir}`);
  }
  const fm = parseFrontmatter(content);
  if (!fm || !fm.name || !fm.description) {
    throw new LibraryError(`SKILL.md frontmatter 非法(name/description 不能为空): ${dir}`);
  }
  return { name: fm.name, description: fm.description };
}

/** SkillEntry → 库内实际目录 */
export function skillDirOf(entry: SkillEntry): string {
  if (entry.id.startsWith('local:')) {
    return path.join(libraryDir(), `local__${entry.id.slice('local:'.length)}`);
  }
  // "owner/repo:path"
  const [repoPart, subPath] = entry.id.split(':');
  const [owner, repo] = repoPart.split('/');
  const base = path.join(libraryDir(), `github__${owner}__${repo}`);
  return subPath ? path.join(base, subPath) : base;
}

function normalizeGithubUri(uri: string): { owner: string; repo: string; cloneUrl: string } {
  // 支持 "owner/repo" 简写与完整 URL
  const m =
    uri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/) ||
    uri.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw new LibraryError(`无法识别的 GitHub 地址: ${uri}`);
  const [, owner, repo] = m;
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/** 从 GitHub 安装:浅克隆后,根或第一层子目录中含 SKILL.md 的都登记入库 */
export async function installFromGithub(uri: string): Promise<SkillEntry[]> {
  const { owner, repo, cloneUrl } = normalizeGithubUri(uri);
  const dest = path.join(libraryDir(), `github__${owner}__${repo}`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(libraryDir(), { recursive: true });
  try {
    await execFileP('git', ['clone', '--depth', '1', cloneUrl, dest]);
  } catch (err) {
    throw new LibraryError(`git clone 失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 收集候选目录:仓库根 + 第一层子目录
  const candidates: { subPath: string; dir: string }[] = [{ subPath: '', dir: dest }];
  for (const ent of await fs.readdir(dest, { withFileTypes: true })) {
    if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
      candidates.push({ subPath: ent.name, dir: path.join(dest, ent.name) });
    }
  }

  const installed: SkillEntry[] = [];
  for (const c of candidates) {
    try {
      const { name, description } = await validateSkillDir(c.dir);
      const entry: SkillEntry = {
        id: `${owner}/${repo}:${c.subPath}`,
        name,
        description,
        source: { type: 'github', uri },
        tags: [],
        installedAt: new Date().toISOString(),
      };
      await upsertSkill(entry);
      installed.push(entry);
    } catch {
      // 该目录不是合法 skill,跳过
    }
  }
  if (installed.length === 0) {
    await fs.rm(dest, { recursive: true, force: true });
    throw new LibraryError(`仓库中未找到合法 skill(无 SKILL.md): ${uri}`);
  }
  return installed;
}

/** 从本地路径安装:复制目录入中央库 */
export async function installFromLocal(dir: string): Promise<SkillEntry> {
  const abs = path.resolve(dir);
  const { name, description } = await validateSkillDir(abs); // SKILL.md 缺失/非法时拒绝
  const id = `local:${name}`;
  const dest = path.join(libraryDir(), `local__${name}`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(libraryDir(), { recursive: true });
  await fs.cp(abs, dest, { recursive: true });
  const entry: SkillEntry = {
    id,
    name,
    description,
    source: { type: 'local', uri: abs },
    tags: [],
    installedAt: new Date().toISOString(),
  };
  await upsertSkill(entry);
  return entry;
}

/** 卸载:删除库目录与注册表记录 */
export async function uninstall(id: string): Promise<boolean> {
  const entry = await getSkill(id);
  if (!entry) return false;
  await fs.rm(skillDirOf(entry), { recursive: true, force: true });
  // github 仓库可能整体是一个目录,若仓库内已无其它登记的 skill 子路径,这里只删自己即可;
  // 简化处理:根级 skill 删除整仓,子路径 skill 只删子目录。
  await removeSkill(id);
  return true;
}

/** 更新:github 来源 git pull;local 来源重新从原路径复制 */
export async function updateSkill(id: string): Promise<SkillEntry> {
  const entry = await getSkill(id);
  if (!entry) throw new LibraryError(`skill 不存在: ${id}`);
  if (entry.source.type === 'github') {
    const { owner, repo } = normalizeGithubUri(entry.source.uri);
    const repoDir = path.join(libraryDir(), `github__${owner}__${repo}`);
    await execFileP('git', ['-C', repoDir, 'pull', '--ff-only']);
    const { name, description } = await validateSkillDir(skillDirOf(entry));
    const next = { ...entry, name, description };
    await upsertSkill(next);
    return next;
  }
  // local:从原路径重新复制
  return installFromLocal(entry.source.uri);
}

/** 自建脚手架:在中央库生成一个合法 skill 并登记 */
export async function initSkill(name: string, description: string): Promise<SkillEntry> {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new LibraryError('skill 名称必须是小写字母/数字/连字符,且以字母或数字开头');
  }
  if (!description) throw new LibraryError('description 不能为空');
  const id = `local:${name}`;
  const dest = path.join(libraryDir(), `local__${name}`);
  await fs.mkdir(dest, { recursive: true });
  const skillMd = `---
name: ${name}
description: ${description}
---

# ${name}

${description}

## 使用说明

在这里编写该 skill 的具体指令内容。
`;
  await fs.writeFile(path.join(dest, 'SKILL.md'), skillMd, 'utf8');
  const entry: SkillEntry = {
    id,
    name,
    description,
    source: { type: 'local', uri: dest },
    tags: ['custom'],
    installedAt: new Date().toISOString(),
  };
  await upsertSkill(entry);
  return entry;
}

export async function listSkills(): Promise<SkillEntry[]> {
  return readRegistry();
}
