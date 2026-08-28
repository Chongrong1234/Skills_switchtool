import { makeAdapter } from './factory.js';

export const kimiCode = makeAdapter({
  id: 'kimi-code',
  displayName: 'Kimi Code',
  homeDir: '.kimi-code',
  skillsSubDir: '.kimi-code/skills',
  capabilities: { hooks: true, allowedTools: true },
});
