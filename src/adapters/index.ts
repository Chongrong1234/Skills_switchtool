import type { AgentAdapter } from './types.js';
import { claudeCode } from './claude-code.js';
import { kimiCode } from './kimi-code.js';
import { cursor } from './cursor.js';
import { codex } from './codex.js';
import { qwenCode } from './qwen-code.js';
import { trae } from './trae.js';
import { factoryDroid } from './factory-droid.js';
import { agents } from './agents.js';
import { geminiCli } from './gemini-cli.js';
import { copilot } from './copilot.js';
import { windsurf } from './windsurf.js';
import { opencode } from './opencode.js';
import { rooCode } from './roo-code.js';
import { openclaw } from './openclaw.js';
import { deepseekHarness } from './deepseek-harness.js';
import { cline } from './cline.js';
import { continueCli } from './continue.js';
import { crush } from './crush.js';
import { amp } from './amp.js';

/** 适配器注册表:全部支持的 agent(带 MCP 支持的在前,通用目录 agents 居中) */
export const adapters: AgentAdapter[] = [
  claudeCode, kimiCode, cursor, codex, qwenCode, trae, factoryDroid,
  agents,
  geminiCli, copilot, windsurf, opencode, rooCode,
  openclaw, deepseekHarness, cline, continueCli, crush, amp,
];

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapters.find((a) => a.id === id);
}
