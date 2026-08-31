/**
 * profile 配置库导出/导入测试:SSW_HOME 隔离 + 注入假 installFn(不碰网络),
 * 覆盖导出→导入回环、幂等、github subdir 推导、local 文件内嵌与格式校验。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateGlobal } from '../src/core/global.js';
import { initSkill, LibraryError, skillDirOf } from '../src/core/library.js';
import { upsertMcp } from '../src/core/mcps.js';
import { createProject, listProjects, setActiveProject, setProjectSkills } from '../src/core/projects.js';
import {
  deriveSubdir,
  exportProfile,
  importProfile,
  PROFILE_FORMAT,
  type ProfileBundle,
} from '../src/core/profile.js';
import { readRegistry, upsertSkill } from '../src/core/registry.js';
import type { SkillEntry } from '../src/core/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = path.join(tmp, 'home-a');
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

function ghEntry(repo: string, sub: string): SkillEntry {
  return {
    id: `${repo}:${sub}`,
    name: sub.split('/').pop() || 'root',
    description: 'gh skill',
    source: { type: 'github', uri: `https://github.com/${repo}` },
    tags: [],
    installedAt: new Date().toISOString(),
  };
}

/** 手工构造 bundle 的骨架(安全预检/边界用例不用先 export) */
function bareBundle(patch: Partial<ProfileBundle>): ProfileBundle {
  return {
    format: PROFILE_FORMAT,
    exportedAt: new Date().toISOString(),
    skills: [],
    mcps: [],
    projects: { projects: [], activeProjectId: null },
    global: { skills: [], agents: [], applyMode: 'symlink' },
    localFiles: {},
    ...patch,
  } as ProfileBundle;
}

describe('deriveSubdir', () => {
  it('全部 subPath 首段一致 → 该首段;含根级或首段不一 → undefined', () => {
    expect(deriveSubdir([ghEntry('o/r', 'skills/a'), ghEntry('o/r', 'skills/b'), ghEntry('o/r', 'skills')], 'o/r')).toBe('skills');
    expect(deriveSubdir([ghEntry('o/r', 'a'), ghEntry('o/r', 'b')], 'o/r')).toBeUndefined();
    expect(deriveSubdir([ghEntry('o/r', ''), ghEntry('o/r', 'skills/a')], 'o/r')).toBeUndefined();
  });
});

describe('profile 导出 → 导入回环', () => {
  it('github 元数据 + local 文件 + mcp + 项目 + 全局档案完整还完', async () => {
    // --- 在 home-a 里造状态:github 条目(直写注册表,不克隆)、local 技能、项目、mcp、全局档案 ---
    await upsertSkill(ghEntry('o/r', 'skills/a'));
    const local = await initSkill('my-local', '本地技能');
    await fs.writeFile(path.join(skillDirOf(local), 'notes.md'), '备注内容', 'utf8');
    const proj = await createProject({ name: 'demo', path: '/x/demo', agents: ['claude-code'], applyMode: 'symlink' });
    await setProjectSkills(proj.id, ['o/r:skills/a', local.id]);
    await setActiveProject(proj.id);
    await upsertMcp({ name: 'fs-server', command: 'npx', args: ['-y', '@mcp/fs'] });
    await updateGlobal({ skills: [local.id], agents: ['agents'], applyMode: 'copy' });

    const { bundle, warnings } = await exportProfile();
    expect(warnings).toEqual([]);
    expect(bundle.format).toBe(PROFILE_FORMAT);
    expect(Object.keys(bundle.localFiles)).toEqual([local.id]);
    expect(Buffer.from(bundle.localFiles[local.id]['notes.md'], 'base64').toString()).toBe('备注内容');

    // --- 切到全新的 home-b 导入(installFn 造假,不碰网络) ---
    process.env.SSW_HOME = path.join(tmp, 'home-b');
    const fakeInstall = async (uri: string, subdir?: string): Promise<SkillEntry[]> => {
      expect(uri).toBe('https://github.com/o/r');
      expect(subdir).toBe('skills'); // 从条目 id 推导出来
      const e = ghEntry('o/r', 'skills/a');
      e.name = 'a-renamed-upstream'; // 模拟上游改名:导入后用 bundle 里的原条目覆盖,保住项目绑定
      await upsertSkill(e);
      return [e];
    };
    const r = await importProfile(bundle, fakeInstall);

    expect(r.installedRepos).toEqual(['o/r']);
    expect(r.failed).toEqual([]);
    expect(r.localRestored).toEqual([local.id]);
    expect(r.projectsAdded).toBe(1);
    expect(r.mcpsAdded).toBe(1);
    expect(r.globalImported).toBe(true);

    const registry = await readRegistry();
    const gh = registry.find((s) => s.id === 'o/r:skills/a');
    expect(gh?.name).toBe('a'); // 原条目元数据盖回上游安装结果
    const restored = registry.find((s) => s.id === local.id);
    expect(restored?.name).toBe('my-local');
    expect(await fs.readFile(path.join(skillDirOf(local), 'notes.md'), 'utf8')).toBe('备注内容');

    const projects = await listProjects();
    expect(projects.projects).toHaveLength(1);
    expect(projects.activeProjectId).toBe(projects.projects[0].id);
    expect(projects.projects[0].skills).toEqual(['o/r:skills/a', local.id]);
    // 项目路径 /x/demo 在本机不存在 → 有提示
    expect(r.warnings.some((w) => w.includes('不存在'))).toBe(true);

    const g = await import('../src/core/global.js').then((m) => m.readGlobal());
    expect(g.agents).toEqual(['agents']);
    expect(g.applyMode).toBe('copy');
  });

  it('幂等:重复导入跳过已有仓库/技能/项目', async () => {
    await upsertSkill(ghEntry('o/r', 'skills/a'));
    const local = await initSkill('dup-local', 'x');
    const proj = await createProject({ name: 'demo', path: tmp, agents: [], applyMode: 'symlink' });
    await setProjectSkills(proj.id, [local.id]);
    const { bundle } = await exportProfile();

    process.env.SSW_HOME = path.join(tmp, 'home-b');
    const fakeInstall = async (): Promise<SkillEntry[]> => [ghEntry('o/r', 'skills/a')];
    await importProfile(bundle, fakeInstall);
    const second = await importProfile(bundle, fakeInstall);
    expect(second.installedRepos).toEqual([]);
    expect(second.skippedRepos).toEqual(['o/r']);
    expect(second.localRestored).toEqual([]);
    expect(second.projectsAdded).toBe(0);
    expect(second.projectsSkipped).toBe(1);
    expect(second.globalImported).toBe(false); // 第一次已导入,第二次不覆盖
    // installFn 第二次不该被调用(仓库已在库中)
  });

  it('单仓失败不中断,记入 failed', async () => {
    await upsertSkill(ghEntry('bad/repo', 'skills/x'));
    await upsertSkill(ghEntry('good/repo', 'skills/y'));
    const { bundle } = await exportProfile();
    process.env.SSW_HOME = path.join(tmp, 'home-b');
    const fakeInstall = async (uri: string): Promise<SkillEntry[]> => {
      if (uri.includes('bad')) throw new LibraryError('网络不可达');
      return [ghEntry('good/repo', 'skills/y')];
    };
    const r = await importProfile(bundle, fakeInstall);
    expect(r.installedRepos).toEqual(['good/repo']);
    expect(r.failed).toEqual([{ repo: 'bad/repo', message: '网络不可达' }]);
  });

  it('格式不符抛 LibraryError;local 缺文件内容告警跳过', async () => {
    await expect(importProfile({ hello: 1 })).rejects.toThrow(LibraryError);
    const local = await initSkill('nofiles', 'x');
    const { bundle } = await exportProfile();
    delete (bundle as ProfileBundle).localFiles[local.id];
    process.env.SSW_HOME = path.join(tmp, 'home-b');
    const r = await importProfile(bundle, async () => []);
    expect(r.localRestored).toEqual([]);
    expect(r.warnings.some((w) => w.includes(local.id))).toBe(true);
  });

  it('项目全部幂等跳过时,activeProjectId 也落盘', async () => {
    // 本机已有同名同路径项目但无激活;bundle 里同 key 项目带 activeProjectId
    const p = await createProject({ name: 'demo', path: tmp, agents: [], applyMode: 'symlink' });
    const bundle = bareBundle({
      projects: { projects: [{ ...p, id: 'imported-id' }], activeProjectId: 'imported-id' },
    });
    const r = await importProfile(bundle, async () => []);
    expect(r.projectsAdded).toBe(0);
    expect(r.projectsSkipped).toBe(1);
    expect((await listProjects()).activeProjectId).toBe(p.id);
  });
});

describe('profile 导入安全预检(bundle 是外部输入)', () => {
  it('local 条目恶意 id(local:../../x)整体跳过,库外目录不被删写', async () => {
    // 恶意 id 的落盘路径会解析到 SSW_HOME 根下的 x/(library/local__../../x);预置内容验证未被 rm
    const escapeTarget = path.join(process.env.SSW_HOME!, 'x');
    await fs.mkdir(escapeTarget, { recursive: true });
    await fs.writeFile(path.join(escapeTarget, 'keep.txt'), 'data', 'utf8');

    const evil: SkillEntry = {
      id: 'local:../../x',
      name: 'x',
      description: 'd',
      source: { type: 'local', uri: '/somewhere' },
      tags: [],
      installedAt: new Date().toISOString(),
    };
    const bundle = bareBundle({
      skills: [evil],
      localFiles: { 'local:../../x': { 'SKILL.md': Buffer.from('---\nname: x\ndescription: d\n---\n').toString('base64') } },
    });
    const r = await importProfile(bundle, async () => []);
    expect(r.localRestored).toEqual([]);
    expect(await readRegistry()).toEqual([]);
    expect(r.warnings.some((w) => w.includes('非法条目'))).toBe(true);
    expect(await fs.readFile(path.join(escapeTarget, 'keep.txt'), 'utf8')).toBe('data');
  });

  it('github 条目恶意 subPath 跳过,installFn 不被调用;name 非法的条目同样跳过', async () => {
    const evilSub: SkillEntry = {
      id: 'o/r:../../x',
      name: 'x',
      description: 'd',
      source: { type: 'github', uri: 'https://github.com/o/r' },
      tags: [],
      installedAt: new Date().toISOString(),
    };
    const evilName: SkillEntry = {
      id: 'o/r2:skills/a',
      name: '../evil',
      description: 'd',
      source: { type: 'github', uri: 'https://github.com/o/r2' },
      tags: [],
      installedAt: new Date().toISOString(),
    };
    let installCalls = 0;
    const r = await importProfile(bareBundle({ skills: [evilSub, evilName] }), async () => {
      installCalls++;
      return [];
    });
    expect(installCalls).toBe(0);
    expect(await readRegistry()).toEqual([]);
    expect(r.warnings.filter((w) => w.includes('非法条目'))).toHaveLength(2);
  });
});
