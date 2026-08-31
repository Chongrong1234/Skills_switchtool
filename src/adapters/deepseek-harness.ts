import { makeAdapter } from './factory.js';

// DeepSeek Harness(dsh,DeepSeek 官方 agent harness,developer preview):
// 官方 skills 扫描根含 <项目>/.dsh/skills(项目级最高优先)与 ~/.dsh/skills(用户级),
// 也读 .agents/skills(通用目录由 agents 适配器覆盖,避免重复物化)。
// MCP 走 Cordis YAML patch(~/.dsh/cordis.patch.yml),非项目级 JSON/TOML,不声明 mcp。
// 注意:该项目官方明示 developer preview 可能有破坏式变更,目录口径未来可能变。
export const deepseekHarness = makeAdapter({
  id: 'deepseek-harness',
  displayName: 'DeepSeek Harness',
  homeDir: '.dsh',
  skillsSubDir: ['.dsh', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
