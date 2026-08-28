/**
 * AgentAdapter 接口,与 PLAN.md 4.4 保持一致。
 */
import type { SkillEntry } from '../core/types.js';

export interface AgentAdapter {
  id: string;                    // "claude-code"
  displayName: string;
  detect(): boolean;             // 本机是否装了该 agent
  projectSkillsDir(projectPath: string): string;  // 项目级 skills 目录
  capabilities: { hooks: boolean; allowedTools: boolean };
  validate?(skill: SkillEntry): string[];          // 返回不兼容告警
}
