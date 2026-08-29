import { jsonMcpSupport, makeAdapter } from './factory.js';

export const claudeCode = makeAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  homeDir: '.claude',
  skillsSubDir: ['.claude', 'skills'],
  capabilities: { hooks: true, allowedTools: true },
  // 项目级 MCP 配置在 <项目根>/.mcp.json;远端条目需显式 type: http|sse
  mcp: jsonMcpSupport(['.mcp.json'], 'claude'),
});
