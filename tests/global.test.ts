/**
 * 全局(用户级)共享应用测试:global.json 档案读写、apply/unapply/rollback。
 * userSkillsDir 基于 os.homedir(),测试用 vi.spyOn 把它指到临时目录,绝不触碰真实 home。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGlobal,
  GLOBAL_SNAPSHOT_ID,
  readGlobal,
  rollbackGlobal,
  unapplyGlobal,
  updateGlobal,
} from '../src/core/global.js';
import { initSkill, skillDirOf } from '../src/core/library.js';
import { globalFile } from '../src/core/paths.js';
import { listSnapshots } from '../src/core/snapshot.js';

let tmp: string;
let fakeHome: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
  fakeHome = path.join(tmp, 'fake-home');
  await fs.mkdir(fakeHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

const claudeUserSkills = () => path.join(fakeHome, '.claude', 'skills');

describe('global 档案读写', () => {
  it('updateGlobal 合并写,readGlobal 读回;缺省为 symlink + 空列表', async () => {
    expect(await readGlobal()).toEqual({ skills: [], agents: [], applyMode: 'symlink', lastAppliedAt: undefined });
    await updateGlobal({ agents: ['claude-code'], skills: ['local:a'] });
    await updateGlobal({ applyMode: 'copy' });
    const p = await readGlobal();
    expect(p.agents).toEqual(['claude-code']);
    expect(p.skills).toEqual(['local:a']);
    expect(p.applyMode).toBe('copy');
  });

  it('global.json 损坏时容错为默认档案', async () => {
    await fs.mkdir(path.dirname(globalFile()), { recursive: true });
    await fs.writeFile(globalFile(), '{oops', 'utf8');
    expect(await readGlobal()).toEqual({ skills: [], agents: [], applyMode: 'symlink', lastAppliedAt: undefined });
  });
});

describe('applyGlobal / unapplyGlobal / rollbackGlobal', () => {
  it('物化到用户级 skills 目录(symlink 指向库内),并记录 lastAppliedAt', async () => {
    const skill = await initSkill('g-skill', '全局共享');
    await updateGlobal({ skills: [skill.id], agents: ['claude-code'] });

    const result = await applyGlobal();
    expect(result.applied).toHaveLength(1);
    const dest = path.join(claudeUserSkills(), 'g-skill');
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(dest)).toBe(await fs.realpath(skillDirOf(skill)));
    expect(typeof (await readGlobal()).lastAppliedAt).toBe('string');
  });

  it('幂等:重复 apply 不重复物化、不产生空快照', async () => {
    const skill = await initSkill('g-idem', '幂等');
    await updateGlobal({ skills: [skill.id], agents: ['claude-code'] });
    await applyGlobal();
    const second = await applyGlobal();
    expect(second.applied).toHaveLength(0);
    expect(await listSnapshots(GLOBAL_SNAPSHOT_ID)).toHaveLength(1);
  });

  it('unapply 只删我们建的,用户自建的同名无关目录原样保留', async () => {
    const skill = await initSkill('g-rm', '待移除');
    await updateGlobal({ skills: [skill.id], agents: ['claude-code'] });
    // 用户自己的 skill(不在库中,内容也不同)
    const own = path.join(claudeUserSkills(), 'user-own');
    await fs.mkdir(own, { recursive: true });
    await fs.writeFile(path.join(own, 'SKILL.md'), '---\nname: user-own\ndescription: 用户自建\n---\n', 'utf8');

    await applyGlobal();
    const { removed } = await unapplyGlobal();
    expect(removed).toHaveLength(1);
    expect(await fs.readFile(path.join(own, 'SKILL.md'), 'utf8')).toContain('user-own');
    await expect(fs.lstat(path.join(claudeUserSkills(), 'g-rm'))).rejects.toThrow();
  });

  it('同名冲突先移入快照,rollback 还原用户原内容', async () => {
    const skill = await initSkill('g-conflict', '库里的版本');
    await updateGlobal({ skills: [skill.id], agents: ['claude-code'] });
    const dest = path.join(claudeUserSkills(), 'g-conflict');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'user-note.txt'), '用户的重要笔记', 'utf8');

    await applyGlobal();
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);

    const rb = await rollbackGlobal();
    expect(rb.restored).toBe(true);
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(dest, 'user-note.txt'), 'utf8')).toBe('用户的重要笔记');
    expect(await listSnapshots(GLOBAL_SNAPSHOT_ID)).toHaveLength(0);
  });

  it('悬空引用与未知 agent 只告警不中断', async () => {
    const skill = await initSkill('g-ok', '正常');
    await updateGlobal({ skills: [skill.id, 'local:ghost'], agents: ['claude-code', 'nope'] });
    const result = await applyGlobal();
    expect(result.applied).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('local:ghost'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('nope'))).toBe(true);
  });
});
