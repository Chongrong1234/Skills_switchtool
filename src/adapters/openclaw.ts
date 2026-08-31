import { makeAdapter } from './factory.js';

// OpenClaw(自托管个人 AI 助手网关,原 Clawdbot/Moltbot;官方 skills 文档):
// skills 加载优先级 <workspace>/skills > <workspace>/.agents/skills > ~/.agents/skills > ~/.openclaw/skills。
// 项目级取开放规范互操作路径 .agents/skills("workspace" 是 agent 工作区概念,
// 与普通项目根不同,不冒写 <项目>/skills),与 agents 适配器同目标,同时启用时幂等跳过;
// 用户级 ~/.openclaw/skills(官方 skills install --global 的目标)。
// MCP 只有全局 ~/.openclaw/openclaw.json 的 mcp.servers,无项目级配置,不声明 mcp。
export const openclaw = makeAdapter({
  id: 'openclaw',
  displayName: 'OpenClaw',
  homeDir: '.openclaw',
  skillsSubDir: ['.agents', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
