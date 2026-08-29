import { makeAdapter } from './factory.js';

// Windsurf:项目级 .windsurf/skills/,用户级 ~/.codeium/windsurf/skills/
// (homeDir 多段,factory 的 userSkillsDir 推导天然支持)
export const windsurf = makeAdapter({
  id: 'windsurf',
  displayName: 'Windsurf',
  homeDir: '.codeium/windsurf',
  skillsSubDir: ['.windsurf', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
