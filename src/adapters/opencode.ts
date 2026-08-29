import { makeAdapter } from './factory.js';

// OpenCode:项目级官方读取路径即通用 .agents/skills/(vercel-labs/skills 支持表),
// 与 agents 适配器同目标,同时启用时幂等跳过;用户级 ~/.config/opencode/skills/。
export const opencode = makeAdapter({
  id: 'opencode',
  displayName: 'OpenCode',
  homeDir: '.config/opencode',
  skillsSubDir: ['.agents', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
