/**
 * 适配器测试:projectSkillsDir/userSkillsDir 路径正确、注册表完整。
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapters, getAdapter } from '../src/adapters/index.js';
import { claudeCode } from '../src/adapters/claude-code.js';
import { kimiCode } from '../src/adapters/kimi-code.js';
import { cursor } from '../src/adapters/cursor.js';
import { codex } from '../src/adapters/codex.js';
import { agents } from '../src/adapters/agents.js';
import { windsurf } from '../src/adapters/windsurf.js';
import { opencode } from '../src/adapters/opencode.js';
import { openclaw } from '../src/adapters/openclaw.js';
import { deepseekHarness } from '../src/adapters/deepseek-harness.js';
import { qwenCode } from '../src/adapters/qwen-code.js';
import { trae } from '../src/adapters/trae.js';
import { cline } from '../src/adapters/cline.js';
import { continueCli } from '../src/adapters/continue.js';
import { crush } from '../src/adapters/crush.js';
import { amp } from '../src/adapters/amp.js';
import { factoryDroid } from '../src/adapters/factory-droid.js';

describe('adapters', () => {
  it('projectSkillsDir 路径正确', () => {
    const proj = '/home/me/proj';
    expect(claudeCode.projectSkillsDir(proj)).toBe(path.join(proj, '.claude/skills'));
    expect(kimiCode.projectSkillsDir(proj)).toBe(path.join(proj, '.kimi-code/skills'));
    expect(cursor.projectSkillsDir(proj)).toBe(path.join(proj, '.cursor/skills'));
    expect(codex.projectSkillsDir(proj)).toBe(path.join(proj, '.codex/skills'));
    // 通用目录与以它为项目级读取路径的 agent(vercel-labs/skills 支持表)
    expect(agents.projectSkillsDir(proj)).toBe(path.join(proj, '.agents/skills'));
    expect(windsurf.projectSkillsDir(proj)).toBe(path.join(proj, '.windsurf/skills'));
    expect(opencode.projectSkillsDir(proj)).toBe(path.join(proj, '.agents/skills'));
    // 第二批:主流框架(目录约定均来自各官方文档)
    expect(qwenCode.projectSkillsDir(proj)).toBe(path.join(proj, '.qwen/skills'));
    expect(trae.projectSkillsDir(proj)).toBe(path.join(proj, '.trae/skills'));
    expect(factoryDroid.projectSkillsDir(proj)).toBe(path.join(proj, '.factory/skills'));
    expect(deepseekHarness.projectSkillsDir(proj)).toBe(path.join(proj, '.dsh/skills'));
    expect(cline.projectSkillsDir(proj)).toBe(path.join(proj, '.cline/skills'));
    expect(continueCli.projectSkillsDir(proj)).toBe(path.join(proj, '.continue/skills'));
    expect(crush.projectSkillsDir(proj)).toBe(path.join(proj, '.crush/skills'));
    // openclaw/amp 项目级走开放规范互操作路径 .agents/skills
    expect(openclaw.projectSkillsDir(proj)).toBe(path.join(proj, '.agents/skills'));
    expect(amp.projectSkillsDir(proj)).toBe(path.join(proj, '.agents/skills'));
  });

  it('userSkillsDir 推导为 ~/<homeDir>/skills(含多段 homeDir)', () => {
    const home = os.homedir();
    expect(claudeCode.userSkillsDir()).toBe(path.join(home, '.claude', 'skills'));
    expect(agents.userSkillsDir()).toBe(path.join(home, '.agents', 'skills'));
    expect(windsurf.userSkillsDir()).toBe(path.join(home, '.codeium', 'windsurf', 'skills'));
    expect(opencode.userSkillsDir()).toBe(path.join(home, '.config', 'opencode', 'skills'));
    expect(openclaw.userSkillsDir()).toBe(path.join(home, '.openclaw', 'skills'));
    expect(deepseekHarness.userSkillsDir()).toBe(path.join(home, '.dsh', 'skills'));
    expect(qwenCode.userSkillsDir()).toBe(path.join(home, '.qwen', 'skills'));
    expect(crush.userSkillsDir()).toBe(path.join(home, '.config', 'crush', 'skills'));
    expect(amp.userSkillsDir()).toBe(path.join(home, '.config', 'amp', 'skills'));
  });

  it('MCP 支持:声明的七家;Qwen 远端 http 用 httpUrl 键,Factory 带 type 字段', () => {
    const withMcp = adapters.filter((a) => a.mcp).map((a) => a.id).sort();
    expect(withMcp).toEqual(['claude-code', 'codex', 'cursor', 'factory-droid', 'kimi-code', 'qwen-code', 'trae']);
    const base = { name: 'x', transport: 'http' as const, url: 'https://mcp.x/sse', addedAt: '' };
    expect(qwenCode.mcp!.toServerConfig(base)).toEqual({ httpUrl: 'https://mcp.x/sse' });
    expect(qwenCode.mcp!.toServerConfig({ ...base, transport: 'sse' })).toEqual({ url: 'https://mcp.x/sse' });
    expect(factoryDroid.mcp!.toServerConfig(base)).toEqual({ type: 'http', url: 'https://mcp.x/sse' });
    expect(factoryDroid.mcp!.toServerConfig({ name: 'x', transport: 'stdio', command: 'npx', args: ['-y', 's'], addedAt: '' }))
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', 's'] });
  });

  it('id 与 displayName', () => {
    expect(claudeCode.id).toBe('claude-code');
    expect(kimiCode.id).toBe('kimi-code');
    expect(cursor.id).toBe('cursor');
    expect(codex.id).toBe('codex');
    for (const a of adapters) expect(a.displayName).toBeTruthy();
  });

  it('capabilities 声明存在且结构正确', () => {
    for (const a of adapters) {
      expect(typeof a.capabilities.hooks).toBe('boolean');
      expect(typeof a.capabilities.allowedTools).toBe('boolean');
    }
  });

  it('注册表可按 id 取适配器', () => {
    expect(adapters).toHaveLength(19);
    expect(getAdapter('claude-code')).toBe(claudeCode);
    expect(getAdapter('agents')).toBe(agents);
    expect(getAdapter('openclaw')).toBe(openclaw);
    expect(getAdapter('deepseek-harness')).toBe(deepseekHarness);
    expect(getAdapter('nope')).toBeUndefined();
  });

  it('detect 返回布尔值;通用目录适配器始终可用', () => {
    for (const a of adapters) expect(typeof a.detect()).toBe('boolean');
    expect(agents.detect()).toBe(true);
  });
});
