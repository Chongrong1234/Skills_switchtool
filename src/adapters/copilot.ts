import { makeAdapter } from './factory.js';

// GitHub Copilot(CLI / coding agent):项目级官方读取路径即通用 .agents/skills/
// (vercel-labs/skills 支持表);与 agents 适配器同目标,同时启用时幂等跳过。
// 用户级为 ~/.copilot/skills(全局共享 apply 的目标)。
export const copilot = makeAdapter({
  id: 'copilot',
  displayName: 'GitHub Copilot',
  homeDir: '.copilot',
  skillsSubDir: ['.agents', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
