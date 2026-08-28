import { makeAdapter } from './factory.js';

export const cursor = makeAdapter({
  id: 'cursor',
  displayName: 'Cursor',
  homeDir: '.cursor',
  skillsSubDir: ['.cursor', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
