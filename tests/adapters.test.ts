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
  });

  it('userSkillsDir 推导为 ~/<homeDir>/skills(含多段 homeDir)', () => {
    const home = os.homedir();
    expect(claudeCode.userSkillsDir()).toBe(path.join(home, '.claude', 'skills'));
    expect(agents.userSkillsDir()).toBe(path.join(home, '.agents', 'skills'));
    expect(windsurf.userSkillsDir()).toBe(path.join(home, '.codeium', 'windsurf', 'skills'));
    expect(opencode.userSkillsDir()).toBe(path.join(home, '.config', 'opencode', 'skills'));
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
    expect(adapters).toHaveLength(10);
    expect(getAdapter('claude-code')).toBe(claudeCode);
    expect(getAdapter('agents')).toBe(agents);
    expect(getAdapter('nope')).toBeUndefined();
  });

  it('detect 返回布尔值;通用目录适配器始终可用', () => {
    for (const a of adapters) expect(typeof a.detect()).toBe('boolean');
    expect(agents.detect()).toBe(true);
  });
});
