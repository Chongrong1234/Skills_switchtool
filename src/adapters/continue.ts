import { makeAdapter } from './factory.js';

// Continue(cn CLI;源码 loadMarkdownSkills.ts 确认):
// skills 目录 ~/.continue/skills(用户级)与 <项目>/.continue/skills(另读 .claude/skills)。
// MCP 走 YAML(~/.continue/config.yaml 的 mcpServers / 项目级 .continue/mcpServers/*.yaml),
// 非 mcpServers JSON 项目级单文件,不声明 mcp。
export const continueCli = makeAdapter({
  id: 'continue',
  displayName: 'Continue',
  homeDir: '.continue',
  skillsSubDir: ['.continue', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
