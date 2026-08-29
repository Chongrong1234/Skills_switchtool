import path from 'node:path';
import type { McpEntry } from '../core/types.js';
import { makeAdapter } from './factory.js';

export const codex = makeAdapter({
  id: 'codex',
  displayName: 'Codex',
  homeDir: '.codex',
  skillsSubDir: ['.codex', 'skills'],
  capabilities: { hooks: true, allowedTools: true },
  // 项目级 MCP 配置在 .codex/config.toml 的 [mcp_servers.<name>] 段(TOML,字段名与 JSON 系不同)
  mcp: {
    format: 'codex-toml',
    configPath: (projectPath: string) => path.join(projectPath, '.codex', 'config.toml'),
    toServerConfig(entry: McpEntry): Record<string, unknown> {
      if (entry.transport === 'stdio') {
        const out: Record<string, unknown> = { command: entry.command };
        if (entry.args?.length) out.args = entry.args;
        if (entry.env && Object.keys(entry.env).length) out.env = entry.env;
        if (entry.cwd) out.cwd = entry.cwd;
        return out;
      }
      // codex 远端走 streamable HTTP;SSE 是 http 的旧传输,codex 不区分
      const out: Record<string, unknown> = { url: entry.url };
      if (entry.headers && Object.keys(entry.headers).length) out.http_headers = entry.headers;
      return out;
    },
  },
});
