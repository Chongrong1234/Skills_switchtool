import { makeAdapter } from './factory.js';

// 通用跨工具目录:.agents/skills 是 Agent Skills 开放规范(agentskills.io)的互操作路径,
// Gemini CLI / Copilot / Codex / OpenCode / Cline / Warp / Zed 等均原生读取(参考 vercel-labs/skills 支持表)。
// 它是约定而非某个具体应用,没有"是否安装"可探测,始终可用。
export const agents = makeAdapter({
  id: 'agents',
  displayName: '通用目录 (.agents/skills)',
  homeDir: '.agents',
  skillsSubDir: ['.agents', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
  detect: () => true,
});
