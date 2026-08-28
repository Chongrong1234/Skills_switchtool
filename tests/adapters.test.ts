/**
 * 适配器测试:projectSkillsDir 路径正确、注册表完整。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapters, getAdapter } from '../src/adapters/index.js';
import { claudeCode } from '../src/adapters/claude-code.js';
import { kimiCode } from '../src/adapters/kimi-code.js';
import { cursor } from '../src/adapters/cursor.js';
import { codex } from '../src/adapters/codex.js';

describe('adapters', () => {
  it('projectSkillsDir 路径正确', () => {
    const proj = '/home/me/proj';
    expect(claudeCode.projectSkillsDir(proj)).toBe(path.join(proj, '.claude/skills'));
    expect(kimiCode.projectSkillsDir(proj)).toBe(path.join(proj, '.kimi-code/skills'));
    expect(cursor.projectSkillsDir(proj)).toBe(path.join(proj, '.cursor/skills'));
    expect(codex.projectSkillsDir(proj)).toBe(path.join(proj, '.codex/skills'));
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
    expect(adapters).toHaveLength(4);
    expect(getAdapter('claude-code')).toBe(claudeCode);
    expect(getAdapter('nope')).toBeUndefined();
  });

  it('detect 返回布尔值(不探测真实环境之外的东西)', () => {
    for (const a of adapters) expect(typeof a.detect()).toBe('boolean');
  });
});
