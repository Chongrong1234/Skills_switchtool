import { makeAdapter } from './factory.js';

export const codex = makeAdapter({
  id: 'codex',
  displayName: 'Codex',
  homeDir: '.codex',
  skillsSubDir: ['.codex', 'skills'],
  capabilities: { hooks: true, allowedTools: true },
});
