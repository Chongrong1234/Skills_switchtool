/**
 * apply/unapply:把技能集物化到各 agent 的 skills 目录(项目级;用户级全局共享见 global.ts)。
 * 默认 symlink(改动即时生效;Windows 用 junction,无需管理员权限);copy 可选;
 * symlink 失败(如无权限)自动降级 copy 并告警。已是我们建的链接/副本时幂等跳过。
 * 同名冲突:既有内容先移入快照再覆盖;apply 前必做快照,可 rollback;中途失败清理空快照。
 * MCP 服务集与 skills 共用同一份快照,rollback 一起还原。
 * materializeSkills / removeMaterialized / resolveSkills 同时供 global.ts 的用户级共享应用复用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAdapter } from '../adapters/index.js';
import { applyProjectMcps, unapplyProjectMcps, type McpAppliedItem } from './apply-mcp.js';
import { skillDirOf } from './library.js';
import { getProject, updateProject } from './projects.js';
import { readRegistry } from './registry.js';
import {
  createSnapshot,
  finalizeSnapshot,
  moveConflictIntoSnapshot,
  recordCreated,
  type SnapshotHandle,
} from './snapshot.js';
import type { ApplyMode, SkillEntry } from './types.js';

export interface ApplyResult {
  applied: { agentId: string; skillName: string; mode: 'symlink' | 'copy'; target: string }[];
  mcpApplied: McpAppliedItem[];   // 全局共享 apply 不涉及 MCP,恒为空数组
  warnings: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** 判断 dest 是否已是指向 src 的符号链接(幂等判断) */
async function isSymlinkTo(dest: string, src: string): Promise<boolean> {
  try {
    const st = await fs.lstat(dest);
    if (!st.isSymbolicLink()) return false;
    const real = await fs.realpath(dest);
    return real === (await fs.realpath(src));
  } catch {
    return false;
  }
}

/**
 * 判断 dest 是否是我们之前复制过去的副本(两边 SKILL.md 内容一致)。
 * copy 模式 / symlink 降级 copy 后的 apply 幂等、unapply 的归属判定都靠它。
 */
async function isSameSkillCopy(dest: string, src: string): Promise<boolean> {
  try {
    const st = await fs.lstat(dest);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const [a, b] = await Promise.all([
      fs.readFile(path.join(dest, 'SKILL.md'), 'utf8').catch(() => null),
      fs.readFile(path.join(src, 'SKILL.md'), 'utf8').catch(() => null),
    ]);
    return a !== null && a === b;
  } catch {
    return false;
  }
}

/** 按 id 列表从注册表解析 entries;悬空引用(注册表被手改/损坏等)记 warning 并跳过,不中断 */
export async function resolveSkills(skillIds: string[], warnings: string[]): Promise<SkillEntry[]> {
  const registry = await readRegistry();
  const skills: SkillEntry[] = [];
  for (const sid of skillIds) {
    const entry = registry.find((s) => s.id === sid);
    if (!entry) {
      warnings.push(`库中找不到 skill: ${sid},已跳过(可重新安装或 bind 移除该引用)`);
      continue;
    }
    skills.push(entry);
  }
  return skills;
}

/**
 * 把一批 skills 物化到指定 skills 目录(项目级,或 global.ts 的用户级共享目录):
 * 幂等跳过我们已建的链接/副本;同名冲突先移入快照;symlink 失败降级 copy 并告警。
 * 物化明细与告警直接累积进 result。
 */
export async function materializeSkills(
  snap: SnapshotHandle,
  agentId: string,
  skillsDir: string,
  skills: SkillEntry[],
  applyMode: ApplyMode,
  result: ApplyResult,
): Promise<void> {
  await fs.mkdir(skillsDir, { recursive: true });

  for (const skill of skills) {
    const src = skillDirOf(skill);
    const dest = path.join(skillsDir, skill.name);

    if (await isSymlinkTo(dest, src)) continue; // 已是我们建的链接,幂等跳过
    // 已是我们复制的副本(上次 copy 模式或 symlink 降级),幂等跳过,
    // 否则会被当成"同名冲突"移进快照,白白消耗快照额度
    if (await isSameSkillCopy(dest, src)) continue;

    // 同名冲突:既有内容移入快照
    if (await pathExists(dest)) {
      await moveConflictIntoSnapshot(snap, agentId, dest);
    }

    let mode: 'symlink' | 'copy' = applyMode;
    if (mode === 'symlink') {
      try {
        // Windows 上用 junction:不需要管理员/开发者模式权限(junction 要求绝对路径,src 已是)
        await fs.symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        // 无权限等场景降级 copy(改动库后需重新 apply)
        mode = 'copy';
        result.warnings.push(
          `symlink 失败(${err instanceof Error ? err.message : String(err)}),已降级为 copy: ${dest}`,
        );
      }
    }
    if (mode === 'copy') {
      await fs.cp(src, dest, { recursive: true });
    }
    recordCreated(snap, agentId, dest);
    result.applied.push({ agentId, skillName: skill.name, mode, target: dest });
  }
}

/**
 * 从某个 skills 目录移除我们之前物化的 entries(只删"确定是我们创建的"):
 * symlink 需指向库内;copy 目录需与库内 SKILL.md 内容一致。返回移除的路径。
 */
export async function removeMaterialized(skillsDir: string, skills: SkillEntry[]): Promise<string[]> {
  const removed: string[] = [];
  for (const skill of skills) {
    const src = skillDirOf(skill);
    const dest = path.join(skillsDir, skill.name);
    let ours = false;
    try {
      const st = await fs.lstat(dest);
      if (st.isSymbolicLink()) {
        const real = await fs.realpath(dest);
        ours = real === (await fs.realpath(src).catch(() => ''));
      } else if (st.isDirectory()) {
        ours = await isSameSkillCopy(dest, src);
      }
    } catch {
      ours = false;
    }
    if (ours) {
      await fs.rm(dest, { recursive: true, force: true });
      removed.push(dest);
    }
  }
  return removed;
}

export async function applyProject(projectId: string): Promise<ApplyResult> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  const result: ApplyResult = { applied: [], mcpApplied: [], warnings: [] };
  const skills = await resolveSkills(project.skills, result.warnings);

  const snap = await createSnapshot(projectId);

  try {
    for (const agentId of project.agents) {
      const adapter = getAdapter(agentId);
      if (!adapter) {
        result.warnings.push(`未知 agent: ${agentId},已跳过`);
        continue;
      }
      await materializeSkills(snap, agentId, adapter.projectSkillsDir(project.path), skills, project.applyMode, result);
    }

    // MCP 服务集:合并写入各 agent 的项目级 MCP 配置,与 skills 共用同一份快照(rollback 一起还原)
    result.mcpApplied = await applyProjectMcps(project, snap, result.warnings);

    await finalizeSnapshot(snap);
  } catch (err) {
    // apply 中途失败(如 EXDEV 之外的磁盘错误):清掉未 finalize 的快照目录,
    // 避免留下没有 manifest 的空壳污染回滚队列(rollback 读到会报"快照 manifest 损坏")
    await fs.rm(snap.dir, { recursive: true, force: true });
    throw err;
  }
  await updateProject(projectId, { lastAppliedAt: new Date().toISOString() });
  return result;
}

/**
 * unapply:把该项目 skills 在各 agent 目录下的物化结果移除。
 * symlink:指向库内则删;copy:目录的 SKILL.md 与库内一致(即是我们复制的)才删。
 * 同时从各 agent 的 MCP 配置中摘掉项目绑定的 server 条目。
 */
export async function unapplyProject(projectId: string): Promise<{ removed: string[] }> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  const registry = await readRegistry();
  const skills = registry.filter((s) => project.skills.includes(s.id));
  const removed: string[] = [];

  for (const agentId of project.agents) {
    const adapter = getAdapter(agentId);
    if (!adapter) continue;
    removed.push(...(await removeMaterialized(adapter.projectSkillsDir(project.path), skills)));
  }
  // MCP 条目一并摘除(只动项目绑定的名字)
  const mcpRemoved = await unapplyProjectMcps(project);
  removed.push(...mcpRemoved.removed);
  return { removed };
}
