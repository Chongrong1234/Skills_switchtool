/**
 * 配置库 profile 导出/导入(ssw-profile@1):
 * 把"中央库 skills + 自建(local)技能文件 + MCP 服务集 + 项目档案 + 全局共享档案"
 * 打包成单个 JSON,拷贝到新机器 `ssw profile import` 即可还原整个配置库,
 * 实现跨机器/跨平台共享(比 ssw1 迁移码完整:迁移码只有 github 仓库级引用)。
 *
 * - github 来源只存元数据,导入时按条目 id 推导 subdir 重克隆;
 * - local 来源内嵌全部文件(base64;单 skill 超过 MAX_LOCAL_BYTES 跳过并告警);
 * - 导入幂等:已在库中的仓库/技能跳过,单仓失败记入 failed 不中断;
 * - 项目 id 冲突换新 id;activeProjectId 仅在目标为空时采用导入值;
 * - profile 是外部输入:文件路径做穿越校验,格式不符直接 LibraryError。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readGlobal, updateGlobal, type GlobalProfile } from './global.js';
import { assertValidSkillName, installFromGithub, LibraryError, skillDirOf } from './library.js';
import { readMcps, upsertMcp } from './mcps.js';
import { libraryDir, projectsFile } from './paths.js';
import { readProjects } from './projects.js';
import { atomicWriteJson, readRegistry, upsertSkill } from './registry.js';
import type { McpEntry, Project, ProjectsData, SkillEntry } from './types.js';

export const PROFILE_FORMAT = 'ssw-profile@1';

/** 单个 local skill 内嵌上限:超过即跳过(profile 是 JSON,不驮大文件) */
const MAX_LOCAL_BYTES = 20 * 1024 * 1024;

export interface ProfileBundle {
  format: typeof PROFILE_FORMAT;
  exportedAt: string;
  skills: SkillEntry[];
  mcps: McpEntry[];
  projects: ProjectsData;
  global: GlobalProfile;
  /** local 来源 skill 的文件内容:skillId -> 相对路径 -> base64 */
  localFiles: Record<string, Record<string, string>>;
}

/** 递归收集 skill 目录文件(跳过 .git/node_modules,不跟随符号链接防环),返回 base64 映射与总字节数 */
async function collectFiles(root: string): Promise<{ files: Record<string, string>; bytes: number }> {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function walk(dir: string, rel: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(abs, r);
      } else if (ent.isFile()) {
        const buf = await fs.readFile(abs);
        bytes += buf.length;
        files[r] = buf.toString('base64');
      }
    }
  }
  await walk(root, '');
  return { files, bytes };
}

/** 导出完整配置库。local 技能读不到/超限时跳过该技能的文件内嵌并告警(条目元数据仍导出) */
export async function exportProfile(): Promise<{ bundle: ProfileBundle; warnings: string[] }> {
  const warnings: string[] = [];
  const skills = await readRegistry();
  const localFiles: Record<string, Record<string, string>> = {};
  for (const s of skills) {
    if (s.source.type !== 'local') continue;
    try {
      const { files, bytes } = await collectFiles(skillDirOf(s));
      if (bytes > MAX_LOCAL_BYTES) {
        warnings.push(`skill ${s.id} 超过 ${Math.round(MAX_LOCAL_BYTES / 1024 / 1024)}MB,未内嵌文件(仅导出元数据)`);
        continue;
      }
      localFiles[s.id] = files;
    } catch (err) {
      warnings.push(`读取 ${s.id} 文件失败,仅导出元数据: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const bundle: ProfileBundle = {
    format: PROFILE_FORMAT,
    exportedAt: new Date().toISOString(),
    skills,
    mcps: await readMcps(),
    projects: await readProjects(),
    global: await readGlobal(),
    localFiles,
  };
  return { bundle, warnings };
}

export interface ImportProfileResult {
  installedRepos: string[];   // 本次新克隆的 github 仓库
  skippedRepos: string[];     // 已在库中、跳过的仓库
  failed: { repo: string; message: string }[];
  localRestored: string[];    // 还原文件的 local 技能
  projectsAdded: number;
  projectsSkipped: number;    // 同名同路径视为同一项目,幂等跳过
  mcpsAdded: number;          // 新增(不含覆盖更新)的 MCP 条目数
  globalImported: boolean;
  warnings: string[];
}

/**
 * 从条目 id("owner/repo:subPath")推导重克隆用的 subdir:
 * 全部 subPath 非空且首段一致 → 该首段即原安装时的 subdir;否则整仓扫描。
 */
export function deriveSubdir(entries: SkillEntry[], repo: string): string | undefined {
  const subs = entries.map((e) => e.id.slice(repo.length + 1));
  if (subs.some((s) => !s)) return undefined;
  const first = subs[0].split('/')[0];
  return subs.every((s) => s.split('/')[0] === first) ? first : undefined;
}

/**
 * 校验 bundle 条目的 id/name 是否安全。profile 是外部输入:
 * id 会参与拼库内路径(skillDirOf,导入时先 rm 再写、uninstall 时递归 rm),
 * name 会参与拼 agent 目录路径(apply)——恶意 bundle 的 "../.." 会穿越出库目录删写文件。
 * 口径与 library.ts 的 assertValidSkillName / normalizeSubdir 一致。
 */
function assertSafeBundleEntry(s: SkillEntry): void {
  assertValidSkillName(typeof s?.name === 'string' ? s.name : '');
  const id = typeof s?.id === 'string' ? s.id : '';
  if (id.startsWith('local:')) {
    assertValidSkillName(id.slice('local:'.length));
    return;
  }
  // github 条目:"owner/repo" 或 "owner/repo:subPath"
  const [repoPart, subPath] = id.split(':');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPart ?? '')) {
    throw new LibraryError(`非法 skill id: ${id}`);
  }
  if (subPath !== undefined) {
    if (/[\\:]/.test(subPath) || !subPath || subPath.split('/').some((p) => !p || p === '.' || p === '..')) {
      throw new LibraryError(`非法 skill id(子目录越界): ${id}`);
    }
  }
}

/**
 * 导入 profile。installFn 可注入(测试避免真实 git clone,同 migrate/recommend 的注入约定)。
 */
export async function importProfile(
  raw: unknown,
  installFn: (uri: string, subdir?: string) => Promise<SkillEntry[]> = installFromGithub,
): Promise<ImportProfileResult> {
  const bundle = raw as ProfileBundle;
  if (!bundle || bundle.format !== PROFILE_FORMAT || !Array.isArray(bundle.skills)) {
    throw new LibraryError(`无法识别的 profile 格式(应为 ${PROFILE_FORMAT})`);
  }
  const result: ImportProfileResult = {
    installedRepos: [], skippedRepos: [], failed: [],
    localRestored: [], projectsAdded: 0, projectsSkipped: 0, mcpsAdded: 0, globalImported: false, warnings: [],
  };
  const existing = new Set((await readRegistry()).map((s) => s.id));

  // ---- 安全预检:非法 id/name 的条目整体跳过(单个放过,skillDirOf 会穿越到库外删写) ----
  const unsafe = new Set<unknown>();
  for (const s of bundle.skills) {
    try {
      assertSafeBundleEntry(s);
    } catch (err) {
      unsafe.add(s);
      result.warnings.push(`跳过非法条目 ${s?.id ?? '?'}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- github 来源:按仓库分组重克隆,再 upsert 原条目以保住项目绑定引用的 id ----
  const byRepo = new Map<string, SkillEntry[]>();
  for (const s of bundle.skills) {
    if (unsafe.has(s) || s.source?.type !== 'github') continue;
    const repo = s.id.split(':')[0];
    const list = byRepo.get(repo) ?? [];
    list.push(s);
    byRepo.set(repo, list);
  }
  for (const [repo, entries] of byRepo) {
    if ([...existing].some((id) => id.startsWith(`${repo}:`))) {
      result.skippedRepos.push(repo);
      continue;
    }
    const uri = entries[0].source.uri || `https://github.com/${repo}`;
    try {
      const installed = await installFn(uri, deriveSubdir(entries, repo));
      const installedIds = new Set(installed.map((i) => i.id));
      for (const e of entries) {
        if (installedIds.has(e.id)) await upsertSkill(e);
        else result.warnings.push(`上游仓库结构已变化,未能还原: ${e.id}`);
      }
      result.installedRepos.push(repo);
    } catch (err) {
      result.failed.push({ repo, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- local 来源:文件落盘到库目录并登记;已在库中的跳过(幂等) ----
  for (const s of bundle.skills) {
    if (unsafe.has(s) || s.source?.type !== 'local') continue;
    if (existing.has(s.id)) continue;
    const files = bundle.localFiles?.[s.id];
    if (!files) {
      result.warnings.push(`profile 中没有 ${s.id} 的文件内容,已跳过`);
      continue;
    }
    const dest = skillDirOf(s);
    // 双保险:落盘目标必须在库目录内(id 已过预检,这里兜底防 skillDirOf 未来被改出洞)
    const libRoot = path.resolve(libraryDir());
    const absDest = path.resolve(dest);
    if (absDest !== libRoot && !absDest.startsWith(libRoot + path.sep)) {
      result.warnings.push(`落盘路径越出库目录,已跳过: ${s.id}`);
      continue;
    }
    await fs.rm(dest, { recursive: true, force: true });
    let bad = false;
    for (const [rel, b64] of Object.entries(files)) {
      // 路径穿越防护:profile 可能来自他人,相对路径必须安全(同 library 的 subdir 校验哲学)
      if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((p) => !p || p === '.' || p === '..')) {
        result.warnings.push(`跳过非法文件路径: ${s.id} -> ${rel}`);
        bad = true;
        continue;
      }
      const abs = path.join(dest, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, Buffer.from(b64, 'base64'));
    }
    if (!bad) {
      await upsertSkill(s);
      result.localRestored.push(s.id);
    } else {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      result.warnings.push(`${s.id} 含非法路径,已整体跳过`);
    }
  }

  // ---- MCP 服务集:逐条 upsert(同名覆盖),名字非法的跳过不中断 ----
  const existingMcpNames = new Set((await readMcps()).map((m) => m.name));
  for (const m of bundle.mcps ?? []) {
    try {
      await upsertMcp(m);
      if (!existingMcpNames.has(m.name)) result.mcpsAdded++;
    } catch (err) {
      result.warnings.push(`MCP ${m?.name ?? '?'} 导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 项目档案:追加合并;id 冲突换新 id;同名同路径幂等跳过;路径不存在仅提示 ----
  const incoming = bundle.projects;
  if (incoming && Array.isArray(incoming.projects)) {
    const cur = await readProjects();
    const usedIds = new Set(cur.projects.map((p) => p.id));
    const projKey = (p: { name: string; path: string }) => `${p.name}::${p.path}`;
    const existingKeys = new Set(cur.projects.map(projKey));
    const idMap = new Map<string, string>();
    let missingPath = 0;
    for (const p of incoming.projects) {
      if (existingKeys.has(projKey(p))) {
        result.projectsSkipped++;
        idMap.set(p.id, cur.projects.find((x) => projKey(x) === projKey(p))!.id);
        continue;
      }
      const id = usedIds.has(p.id) ? crypto.randomUUID() : p.id;
      usedIds.add(id);
      idMap.set(p.id, id);
      existingKeys.add(projKey(p));
      const proj: Project = { ...p, id, mcps: p.mcps ?? [] };
      cur.projects.push(proj);
      result.projectsAdded++;
      if (!(await fs.stat(proj.path).catch(() => null))?.isDirectory()) missingPath++;
    }
    // activeProjectId 仅在本机空缺时采用;注意项目全部幂等跳过(projectsAdded=0)时也要落盘
    let activeChanged = false;
    if (!cur.activeProjectId && typeof incoming.activeProjectId === 'string') {
      cur.activeProjectId = idMap.get(incoming.activeProjectId) ?? null;
      activeChanged = cur.activeProjectId !== null;
    }
    if (result.projectsAdded > 0 || activeChanged) await atomicWriteJson(projectsFile(), cur);
    if (missingPath > 0) result.warnings.push(`${missingPath} 个导入项目的路径在本机不存在,请在项目设置里修正`);
  }

  // ---- 全局共享档案:本机已有配置时不覆盖(降级为告警),空配置才采用导入值 ----
  const g = bundle.global;
  if (g && ((g.skills?.length ?? 0) > 0 || (g.agents?.length ?? 0) > 0)) {
    const cur = await readGlobal();
    if (cur.skills.length === 0 && cur.agents.length === 0) {
      await updateGlobal({
        skills: g.skills ?? [],
        agents: g.agents ?? [],
        applyMode: g.applyMode === 'copy' ? 'copy' : 'symlink',
      });
      result.globalImported = true;
    } else {
      result.warnings.push('本机已有全局共享配置,已跳过导入的全局档案');
    }
  }

  return result;
}
