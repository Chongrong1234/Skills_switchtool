import { makeAdapter } from './factory.js';

// Gemini CLI 官方文档:工作区级 .gemini/skills/ 与 .agents/skills/ 均可读(.agents 优先,
// 通用目录由 agents 适配器覆盖,这里用 agent 专属目录避免重复物化)
export const geminiCli = makeAdapter({
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  homeDir: '.gemini',
  skillsSubDir: ['.gemini', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
