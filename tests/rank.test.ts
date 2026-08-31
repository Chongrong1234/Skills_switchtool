/**
 * rank 测试:热度打分(使用次数 > 项目分类匹配 > stars)、稳定排序、
 * 绑定即计使用次数(setProjectSkills/updateGlobal 差集口径)、stars 采集软失败。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRepoStars, registerSkillsIn } from '../src/core/library.js';
import { readGlobal, updateGlobal } from '../src/core/global.js';
import { createProject, setProjectSkills } from '../src/core/projects.js';
import { projectRankContext, rankSkills, skillScore } from '../src/core/rank.js';
import { readRegistry, writeRegistry } from '../src/core/registry.js';
import type { SkillEntry } from '../src/core/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function entry(id: string, extra: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id,
    name: id,
    description: '',
    source: { type: 'local', uri: '/x' },
    tags: [],
    installedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('skillScore / rankSkills', () => {
  it('使用次数是最强信号(每次 +10),压过 stars', () => {
    const used = skillScore(entry('a', { useCount: 2 }));
    const famous = skillScore(entry('b', { stars: 10000 }));
    expect(used).toBe(20);
    expect(famous).toBeCloseTo(Math.log10(10001) * 4, 5);
    expect(used).toBeGreaterThan(famous);
  });

  it('项目分类匹配:关键词命中 name/description/tags 每个 +6', () => {
    const s = entry('x', { name: 'react-helper', description: '组件审查', tags: ['frontend'] });
    const base = skillScore(s);
    const hit = skillScore(s, { keywords: ['react', 'frontend'] });
    expect(hit - base).toBe(12);
  });

  it('rankSkills 稳定降序且不修改入参;同分保持原顺序', async () => {
    const skills = [
      entry('plain'),
      entry('hot', { useCount: 1 }),
      entry('star', { stars: 100 }),
    ];
    const ranked = rankSkills(skills);
    expect(ranked.map((s) => s.id)).toEqual(['hot', 'star', 'plain']);
    expect(skills[0].id).toBe('plain'); // 入参未被原地修改
    // 同分稳定:两个零分保持注册表顺序
    const tied = rankSkills([entry('z1'), entry('z2')]);
    expect(tied.map((s) => s.id)).toEqual(['z1', 'z2']);
  });

  it('projectRankContext:技术栈 + 项目名分词(小写、去重)', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    const ctx = await projectRankContext(tmp, 'My-Admin Console');
    expect(ctx.keywords).toContain('node');
    expect(ctx.keywords).toContain('admin');
    expect(ctx.keywords).toContain('console');
    // 单字符词被过滤
    expect(ctx.keywords).not.toContain('y');
  });
});

describe('绑定即计使用次数(差集口径,只增不减)', () => {
  it('setProjectSkills:新增 id 才计数,重存同集不重复计', async () => {
    await writeRegistry([entry('local:a'), entry('local:b')]);
    const p = await createProject({ name: 'p', path: '/tmp/p', agents: [], applyMode: 'symlink' });
    await setProjectSkills(p.id, ['local:a']);
    let reg = await readRegistry();
    expect(reg.find((s) => s.id === 'local:a')?.useCount).toBe(1);
    expect(reg.find((s) => s.id === 'local:a')?.lastUsedAt).toBeTruthy();
    // 重存包含旧 id 的集合:local:a 不再计,local:b 首次计
    await setProjectSkills(p.id, ['local:a', 'local:b']);
    reg = await readRegistry();
    expect(reg.find((s) => s.id === 'local:a')?.useCount).toBe(1);
    expect(reg.find((s) => s.id === 'local:b')?.useCount).toBe(1);
    // 移除不算负向:解绑后 useCount 保留
    await setProjectSkills(p.id, []);
    reg = await readRegistry();
    expect(reg.find((s) => s.id === 'local:a')?.useCount).toBe(1);
  });

  it('updateGlobal 同口径:全局技能集新增 id 计数', async () => {
    await writeRegistry([entry('local:g')]);
    await updateGlobal({ skills: ['local:g'] });
    expect((await readRegistry())[0].useCount).toBe(1);
    await updateGlobal({ skills: ['local:g'] }); // 同集重存不计
    expect((await readRegistry())[0].useCount).toBe(1);
    await updateGlobal({ skills: [] }); // 清空不扣
    expect((await readRegistry())[0].useCount).toBe(1);
    expect((await readGlobal()).skills).toEqual([]);
  });
});

describe('stars 采集', () => {
  it('fetchRepoStars:正常返回 stargazers_count;404/断网软失败 undefined', async () => {
    const ok = (async () => ({ ok: true, json: async () => ({ stargazers_count: 4321 }) })) as unknown as typeof fetch;
    expect(await fetchRepoStars('a', 'b', ok)).toBe(4321);
    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchRepoStars('a', 'b', notFound)).toBeUndefined();
    const boom = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    expect(await fetchRepoStars('a', 'b', boom)).toBeUndefined();
  });

  it('registerSkillsIn 记入 meta.stars;重装保留 useCount、刷新 stars', async () => {
    const repoDir = path.join(tmp, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'SKILL.md'),
      '---\nname: demo\ndescription: 演示\n---\n正文',
      'utf8',
    );
    // 预置历史统计:该条目之前被用过 3 次
    await writeRegistry([entry('alice/demo:', { useCount: 3, lastUsedAt: '2026-01-01T00:00:00Z', stars: 10 })]);
    const installed = await registerSkillsIn(repoDir, 'alice/demo', 'alice/demo', undefined, { stars: 999 });
    expect(installed).toHaveLength(1);
    expect(installed[0].stars).toBe(999);          // stars 刷新为本次采集值
    expect(installed[0].useCount).toBe(3);          // 使用统计保留
    expect(installed[0].lastUsedAt).toBe('2026-01-01T00:00:00Z');
  });
});
