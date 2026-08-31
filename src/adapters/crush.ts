import { makeAdapter } from './factory.js';

// Crush(Charm;官方 README):skills 项目级 .crush/skills(另读 .agents/skills 等,
// 通用目录由 agents 适配器覆盖);用户级 ~/.config/crush/skills(XDG 口径,另有
// ~/.config/agents/skills 等兼容位)。MCP 走 crushrc 命令式(crush mcp add),
// 无项目级 JSON 配置文件,不声明 mcp。
export const crush = makeAdapter({
  id: 'crush',
  displayName: 'Crush',
  homeDir: '.config/crush',
  skillsSubDir: ['.crush', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
