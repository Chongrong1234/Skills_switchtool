/**
 * 全局(用户级)共享应用:把选定的 skills 物化到各 agent 的用户级 skills 目录
 * (~/.claude/skills、~/.agents/skills 等),一次配置,该 agent 的所有项目共享——
 * 这是"跨 agent 共享配置库"的核心:同一份中央库,分发到多个 agent 的用户级目录。
 *
 * 档案存 global.json(沿用 projects.json 的原子写/容错读约定);
 * 快照挂在固定名 "__global__" 下(snapshots/__global__/),回滚复用 snapshot.rollback。
 * 物化/移除逻辑复用 apply.ts 的 materializeSkills / removeMaterialized,语义与项目级一致。
 * MCP 配置是项目级概念,全局共享只管 skills。
 */
import fs from 'node:fs/promises';
import { getAdapter } from '../adapters/index.js';
import {
  materializeSkills,
  removeMaterialized,
  resolveSkills,
  type ApplyResult,
} from './apply.js';
import { globalFile } from './paths.js';
import { atomicWriteJson, readJsonSafe, readRegistry } from './registry.js';
import { createSnapshot, finalizeSnapshot, rollback } from './snapshot.js';
import type { ApplyMode } from './types.js';

/** 全局档案在快照体系里的固定名(不可能与项目的 randomUUID 冲突) */
export const GLOBAL_SNAPSHOT_ID = '__global__';

export interface GlobalProfile {
  skills: string[];        // SkillEntry.id 列表
  agents: string[];        // 目标 agent id 列表
  applyMode: ApplyMode;
  lastAppliedAt?: string;
}

export async function readGlobal(): Promise<GlobalProfile> {
  const data = await readJsonSafe<Partial<GlobalProfile>>(globalFile(), {});
  // 字段级容错:SSW_HOME 是用户可手改的状态区,类型不对就回落默认而不是崩溃
  return {
    skills: Array.isArray(data.skills) ? data.skills : [],
    agents: Array.isArray(data.agents) ? data.agents : [],
    applyMode: data.applyMode === 'copy' ? 'copy' : 'symlink',
    lastAppliedAt: typeof data.lastAppliedAt === 'string' ? data.lastAppliedAt : undefined,
  };
}

export async function updateGlobal(
  patch: Partial<Pick<GlobalProfile, 'skills' | 'agents' | 'applyMode'>>,
): Promise<GlobalProfile> {
  const next = { ...(await readGlobal()), ...patch };
  await atomicWriteJson(globalFile(), next);
  return next;
}

/** 全局共享 apply:物化到各 agent 的用户级 skills 目录;先快照,可用 rollbackGlobal 还原 */
export async function applyGlobal(): Promise<ApplyResult> {
  const profile = await readGlobal();
  const result: ApplyResult = { applied: [], mcpApplied: [], warnings: [] };
  const skills = await resolveSkills(profile.skills, result.warnings);

  const snap = await createSnapshot(GLOBAL_SNAPSHOT_ID);
  try {
    for (const agentId of profile.agents) {
      const adapter = getAdapter(agentId);
      if (!adapter) {
        result.warnings.push(`未知 agent: ${agentId},已跳过`);
        continue;
      }
      await materializeSkills(snap, agentId, adapter.userSkillsDir(), skills, profile.applyMode, result);
    }
    await finalizeSnapshot(snap);
  } catch (err) {
    // 与 applyProject 同理:中途失败清掉未 finalize 的空快照
    await fs.rm(snap.dir, { recursive: true, force: true });
    throw err;
  }
  await atomicWriteJson(globalFile(), { ...profile, lastAppliedAt: new Date().toISOString() });
  return result;
}

/** 移除全局共享的物化结果(只删确定是我们创建的,判定同项目级 unapply) */
export async function unapplyGlobal(): Promise<{ removed: string[] }> {
  const profile = await readGlobal();
  const registry = await readRegistry();
  const skills = registry.filter((s) => profile.skills.includes(s.id));
  const removed: string[] = [];
  for (const agentId of profile.agents) {
    const adapter = getAdapter(agentId);
    if (!adapter) continue;
    removed.push(...(await removeMaterialized(adapter.userSkillsDir(), skills)));
  }
  return { removed };
}

/** 回滚最近一次全局 apply 的快照 */
export async function rollbackGlobal(): Promise<{ restored: boolean; detail: string }> {
  return rollback(GLOBAL_SNAPSHOT_ID);
}
