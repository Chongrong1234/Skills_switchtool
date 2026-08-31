import { jsonMcpSupport, makeAdapter } from './factory.js';

// Trae(字节;官方 IDE 文档 skills/add-mcp-servers):
// skills 目录 ~/.trae/skills(用户级)与 <项目>/.trae/skills(另读 .agents/skills,
// 通用目录由 agents 适配器覆盖,避免重复物化)。
// MCP:项目级 .trae/mcp.json(mcpServers JSON,官方明确);远端仅 url(cursor 同口径自动探测)。
export const trae = makeAdapter({
  id: 'trae',
  displayName: 'Trae',
  homeDir: '.trae',
  skillsSubDir: ['.trae', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
  mcp: jsonMcpSupport(['.trae', 'mcp.json'], 'plain'),
});
