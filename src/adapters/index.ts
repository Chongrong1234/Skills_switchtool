import type { AgentAdapter } from './types.js';
import { claudeCode } from './claude-code.js';
import { kimiCode } from './kimi-code.js';
import { cursor } from './cursor.js';
import { codex } from './codex.js';
import { agents } from './agents.js';
import { geminiCli } from './gemini-cli.js';
import { copilot } from './copilot.js';
import { windsurf } from './windsurf.js';
import { opencode } from './opencode.js';
import { rooCode } from './roo-code.js';

/** 适配器注册表:全部支持的 agent */
export const adapters: AgentAdapter[] = [
  claudeCode, kimiCode, cursor, codex,
  agents, geminiCli, copilot, windsurf, opencode, rooCode,
];

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapters.find((a) => a.id === id);
}
