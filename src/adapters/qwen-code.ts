import path from 'node:path';
import type { McpEntry } from '../core/types.js';
import { makeAdapter } from './factory.js';
import type { McpSupport } from './types.js';

// Qwen Code(阿里,gemini-cli fork;官方 skills/MCP 文档):
// skills 目录 ~/.qwen/skills(用户级)与 <项目>/.qwen/skills。
// MCP:项目级 .qwen/settings.json 的 mcpServers 字段(结构化合并保留其它设置);
// 远端写法与别家不同——streamable http 用 httpUrl 键,sse 用 url 键;stdio command/args/env/cwd。
const mcp: McpSupport = {
  format: 'json',
  configPath: (projectPath: string) => path.join(projectPath, '.qwen', 'settings.json'),
  toServerConfig(entry: McpEntry): Record<string, unknown> {
    if (entry.transport === 'stdio') {
      const out: Record<string, unknown> = { command: entry.command };
      if (entry.args?.length) out.args = entry.args;
      if (entry.env && Object.keys(entry.env).length) out.env = entry.env;
      if (entry.cwd) out.cwd = entry.cwd;
      return out;
    }
    const out: Record<string, unknown> = {};
    out[entry.transport === 'http' ? 'httpUrl' : 'url'] = entry.url;
    if (entry.headers && Object.keys(entry.headers).length) out.headers = entry.headers;
    return out;
  },
};

export const qwenCode = makeAdapter({
  id: 'qwen-code',
  displayName: 'Qwen Code',
  homeDir: '.qwen',
  skillsSubDir: ['.qwen', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
  mcp,
});
