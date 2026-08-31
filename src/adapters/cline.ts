import { makeAdapter } from './factory.js';

// Cline(CLI 与 VS Code 扩展;官方 docs.cline.bot skills 文档):
// skills 目录 ~/.cline/skills(用户级)与 <项目>/.cline/skills(另读 .clinerules/skills、.claude/skills)。
// MCP:CLI 只有用户级 ~/.cline/mcp.json(IDE 扩展存 VS Code globalStorage)——
// MCP 在本工具是项目级概念,无项目级配置目标,不声明 mcp。
export const cline = makeAdapter({
  id: 'cline',
  displayName: 'Cline',
  homeDir: '.cline',
  skillsSubDir: ['.cline', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
