import { makeAdapter } from './factory.js';

// Roo Code(VSCode 扩展,agentskills.io 官方 client):.roo/skills/(vercel-labs/skills 支持表)
export const rooCode = makeAdapter({
  id: 'roo-code',
  displayName: 'Roo Code',
  homeDir: '.roo',
  skillsSubDir: ['.roo', 'skills'],
  capabilities: { hooks: false, allowedTools: false },
});
