import { jsonMcpSupport, makeAdapter } from './factory.js';

export const cursor = makeAdapter({
  id: 'cursor',
  displayName: 'Cursor',
  homeDir: '.cursor',
  skillsSubDir: ['.cursor', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
  // 项目级 MCP 配置在 .cursor/mcp.json;远端条目 { url } 自动探测传输
  mcp: jsonMcpSupport(['.cursor', 'mcp.json'], 'plain'),
});
