import { makeAdapter } from './factory.js';

// Amp(Sourcegraph;官方 manual/agent-skills):项目级官方读取路径为通用 .agents/skills
// (向上搜到仓库根),与 agents 适配器同目标,同时启用时幂等跳过;
// 用户级 ~/.config/amp/skills(官方优先级 ~/.config/agents/skills → ~/.agents/skills
// → ~/.config/amp/skills,取 agent 专属的最后一档避免与通用目录重复物化)。
// MCP 在 ~/.config/amp/settings.json(amp.mcpServers,用户级),无项目级配置,不声明 mcp。
export const amp = makeAdapter({
  id: 'amp',
  displayName: 'Amp',
  homeDir: '.config/amp',
  skillsSubDir: ['.agents', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
