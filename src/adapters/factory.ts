import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpEntry } from '../core/types.js';
import type { AgentAdapter, McpSupport } from './types.js';

/**
 * 各 agent 的用户级配置目录名(detect 依据)与项目级 skills 相对目录(分段,避免 Windows 混合分隔符)。
 * homeDir 允许多段(如 '.codeium/windsurf'),用户级 skills 目录统一推导为 ~/<homeDir>/skills。
 */
interface AgentSpec {
  id: string;
  displayName: string;
  homeDir: string;         // ~/.xxx(可多段,如 windsurf 的 .codeium/windsurf)
  skillsSubDir: string[];  // 项目内如 ['.claude', 'skills']
  capabilities: { hooks: boolean; allowedTools: boolean };
  detect?(): boolean;      // 覆盖默认探测(通用目录类适配器没有"是否安装"可言,始终可用)
  mcp?: McpSupport;
}

export function makeAdapter(spec: AgentSpec): AgentAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    detect: spec.detect ?? (() => fs.existsSync(path.join(os.homedir(), spec.homeDir))),
    projectSkillsDir(projectPath: string): string {
      return path.join(projectPath, ...spec.skillsSubDir);
    },
    userSkillsDir(): string {
      return path.join(os.homedir(), spec.homeDir, 'skills');
    },
    capabilities: spec.capabilities,
    mcp: spec.mcp,
  };
}

/**
 * mcpServers JSON 系(claude-code / cursor / kimi-code)的 MCP 支持快捷构造。
 * stdio 三家一致({command, args, env});差异在远端条目的类型字段写法:
 *   claude → { type: 'http'|'sse', url, headers? }
 *   plain  → { url, headers? }(cursor 自动探测)
 *   kimi   → http 同 plain;sse 用 { transport: 'sse', url, headers? }
 * withCwd: stdio 是否带 cwd(目前仅 kimi-code 文档明确支持)。
 */
export function jsonMcpSupport(
  fileSegments: string[],
  remoteStyle: 'claude' | 'plain' | 'kimi',
  withCwd = false,
): McpSupport {
  return {
    format: 'json',
    configPath: (projectPath: string) => path.join(projectPath, ...fileSegments),
    toServerConfig(entry: McpEntry): Record<string, unknown> {
      if (entry.transport === 'stdio') {
        const out: Record<string, unknown> = { command: entry.command };
        if (entry.args?.length) out.args = entry.args;
        if (entry.env && Object.keys(entry.env).length) out.env = entry.env;
        if (withCwd && entry.cwd) out.cwd = entry.cwd;
        return out;
      }
      const out: Record<string, unknown> = {};
      if (remoteStyle === 'claude') out.type = entry.transport; // 'http' | 'sse'
      if (remoteStyle === 'kimi' && entry.transport === 'sse') out.transport = 'sse';
      out.url = entry.url;
      if (entry.headers && Object.keys(entry.headers).length) out.headers = entry.headers;
      return out;
    },
  };
}
