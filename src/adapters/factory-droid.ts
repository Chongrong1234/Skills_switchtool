import path from 'node:path';
import type { McpEntry } from '../core/types.js';
import { makeAdapter } from './factory.js';
import type { McpSupport } from './types.js';

// Factory Droid(官方 cli 文档 skills/mcp):
// skills 目录 ~/.factory/skills(用户级)与 <项目>/.factory/skills(另兼容 .agents/skills,
// 通用目录由 agents 适配器覆盖,避免重复物化)。
// MCP:项目级 .factory/mcp.json(mcpServers);条目带 type 字段(stdio/http/sse),
// stdio 用 command/args/env,远端用 url/headers。
const mcp: McpSupport = {
  format: 'json',
  configPath: (projectPath: string) => path.join(projectPath, '.factory', 'mcp.json'),
  toServerConfig(entry: McpEntry): Record<string, unknown> {
    if (entry.transport === 'stdio') {
      const out: Record<string, unknown> = { type: 'stdio', command: entry.command };
      if (entry.args?.length) out.args = entry.args;
      if (entry.env && Object.keys(entry.env).length) out.env = entry.env;
      return out;
    }
    const out: Record<string, unknown> = { type: entry.transport, url: entry.url };
    if (entry.headers && Object.keys(entry.headers).length) out.headers = entry.headers;
    return out;
  },
};

export const factoryDroid = makeAdapter({
  id: 'factory-droid',
  displayName: 'Factory Droid',
  homeDir: '.factory',
  skillsSubDir: ['.factory', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
  mcp,
});
