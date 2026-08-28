import type { AgentAdapter } from './types.js';
import { claudeCode } from './claude-code.js';
import { kimiCode } from './kimi-code.js';
import { cursor } from './cursor.js';
import { codex } from './codex.js';

/** 适配器注册表:全部支持的 agent */
export const adapters: AgentAdapter[] = [claudeCode, kimiCode, cursor, codex];

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapters.find((a) => a.id === id);
}
