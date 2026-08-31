/**
 * AgentAdapter 接口,与 PLAN.md 4.4 保持一致。
 * mcp 可选:声明该 agent 的项目级 MCP 配置文件位置与序列化方式,
 * 未声明的 agent 在 apply MCP 时跳过并告警。
 */
import type { McpEntry } from '../core/types.js';

/** 项目级 MCP 配置目标:配置文件路径 + 格式 + 条目序列化 */
export interface McpSupport {
  format: 'json' | 'codex-toml';   // json = { "mcpServers": {...} };codex-toml = config.toml 的 [mcp_servers.*] 段
  configPath(projectPath: string): string;  // 项目级 MCP 配置文件绝对路径
  /** 把中央库条目转成该 agent 配置里的单个 server 配置(json 的值 / toml 的段内容) */
  toServerConfig(entry: McpEntry): Record<string, unknown>;
}

export interface AgentAdapter {
  id: string;                    // "claude-code"
  displayName: string;
  detect(): boolean;             // 本机是否装了该 agent
  projectSkillsDir(projectPath: string): string;  // 项目级 skills 目录
  userSkillsDir(): string;       // 用户级(全局)skills 目录,全局共享 apply 的目标
  capabilities: { hooks: boolean; allowedTools: boolean };
  mcp?: McpSupport;
}
