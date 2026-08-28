import { makeAdapter } from './factory.js';

export const claudeCode = makeAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  homeDir: '.claude',
  skillsSubDir: ['.claude', 'skills'],
  capabilities: { hooks: true, allowedTools: true },
});
