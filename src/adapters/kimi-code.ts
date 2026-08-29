import { jsonMcpSupport, makeAdapter } from './factory.js';

export const kimiCode = makeAdapter({
  id: 'kimi-code',
  displayName: 'Kimi Code',
  homeDir: '.kimi-code',
  skillsSubDir: ['.kimi-code', 'skills'],
  capabilities: { hooks: true, allowedTools: true },
  // 项目级 MCP 配置在 .kimi-code/mcp.json;http 为默认,sse 需显式 transport;stdio 支持 cwd
  mcp: jsonMcpSupport(['.kimi-code', 'mcp.json'], 'kimi', true),
});
