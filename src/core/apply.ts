/**
 * apply/unapply:把项目技能集物化到各 agent 的项目级 skills 目录。
 * 默认 symlink(改动即时生效);copy 可选;symlink 失败(如 Windows 无权限)自动降级 copy 并告警。
 * 同名冲突:既有内容先移入快照再覆盖;apply 前必做快照,可 rollback。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAdapter } from '../adapters/index.js';
import { skillDirOf } from './library.js';
import { getProject, updateProject } from './projects.js';
import { readRegistry } from './registry.js';
import {
  createSnapshot,
  finalizeSnapshot,
  moveConflictIntoSnapshot,
  recordCreated,
} from './snapshot.js';
import type { SkillEntry } from './types.js';

export interface ApplyResult {
  applied: { agentId: string; skillName: string; mode: 'symlink' | 'copy'; target: string }[];
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

export async function applyProject(projectId: string): Promise<ApplyResult> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  const registry = await readRegistry();
  const skills: SkillEntry[] = [];
  for (const sid of project.skills) {
    const entry = registry.find((s) => s.id === sid);
    if (!entry) throw new Error(`库中找不到 skill: ${sid}`);
    skills.push(entry);
  }

  const result: ApplyResult = { applied: [], warnings: [] };
  const snap = await createSnapshot(projectId);

  for (const agentId of project.agents) {
    const adapter = getAdapter(agentId);
    if (!adapter) {
      result.warnings.push(`未知 agent: ${agentId},已跳过`);
      continue;
    }
    const skillsDir = adapter.projectSkillsDir(project.path);
    await fs.mkdir(skillsDir, { recursive: true });

    for (const skill of skills) {
      const src = skillDirOf(skill);
      const dest = path.join(skillsDir, skill.name);

      if (await isSymlinkTo(dest, src)) continue; // 已是我们建的链接,幂等跳过

      // 同名冲突:既有内容移入快照
      if (await pathExists(dest)) {
        await moveConflictIntoSnapshot(snap, agentId, dest);
      }

      let mode: 'symlink' | 'copy' = project.applyMode;
      if (mode === 'symlink') {
        try {
          await fs.symlink(src, dest, 'dir');
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

  await finalizeSnapshot(snap);
  await updateProject(projectId, { lastAppliedAt: new Date().toISOString() });
  return result;
}

/**
 * unapply:把该项目 skills 在各 agent 目录下的物化结果移除。
 * symlink:指向库内则删;copy:目录的 SKILL.md 与库内一致(即是我们复制的)才删。
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
    const skillsDir = adapter.projectSkillsDir(project.path);

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
          const [a, b] = await Promise.all([
            fs.readFile(path.join(dest, 'SKILL.md'), 'utf8').catch(() => null),
            fs.readFile(path.join(src, 'SKILL.md'), 'utf8').catch(() => null),
          ]);
          ours = a !== null && a === b;
        }
      } catch {
        ours = false;
      }
      if (ours) {
        await fs.rm(dest, { recursive: true, force: true });
        removed.push(dest);
      }
    }
  }
  return { removed };
}
