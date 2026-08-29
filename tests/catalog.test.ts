/**
 * catalog 推荐库测试:数据完整性、过滤/排序、installed 标记,以及合集仓库 subdir 安装链路。
 * 推荐库数据是内置静态数据,测试不访问网络;SSW_HOME 隔离服务于 registry 标记与登记。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG,
  CATALOG_CATEGORIES,
  listCatalog,
  listCatalogCategories,
  listCatalogWithInstalled,
} from '../src/core/catalog.js';
import { installFromGithub, LibraryError, registerSkillsIn } from '../src/core/library.js';
import { upsertMcp } from '../src/core/mcps.js';
import { upsertSkill } from '../src/core/registry.js';
import type { SkillEntry } from '../src/core/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('catalog 静态数据完整性', () => {
  it('条目非空且 id 无重复', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(15);
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it('skill 条目(缺省 kind):id 为 owner/repo,url 与 id 对应,stars > 0', () => {
    const skills = CATALOG.filter((e) => e.kind !== 'mcp');
    expect(skills.length).toBeGreaterThanOrEqual(15);
    for (const e of skills) {
      expect(e.id).toMatch(/^[^/\s]+\/[^/\s]+$/);
      expect(e.stars).toBeGreaterThan(0);
      expect(e.url).toBe(`https://github.com/${e.id}`);
      expect(e.mcp).toBeUndefined();
    }
  });

  it('MCP 条目:id 合法 server 名,载荷与 transport 匹配(stdio 有 command,远端有 url)', () => {
    const mcps = CATALOG.filter((e) => e.kind === 'mcp');
    expect(mcps.length).toBeGreaterThanOrEqual(10);
    for (const e of mcps) {
      expect(e.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(e.stars).toBeGreaterThanOrEqual(0); // 无公开仓库的官方托管 MCP 记 0
      expect(e.subdir).toBeUndefined();
      const spec = e.mcp;
      expect(spec).toBeDefined();
      if (spec!.transport === 'stdio') {
        expect(spec!.command).toBeTruthy();
        expect(spec!.url).toBeUndefined();
      } else {
        expect(spec!.url).toMatch(/^https:\/\//);
        expect(spec!.command).toBeUndefined();
      }
    }
  });

  it('每条 entry 的 category 都在分类表中;每个分类至少一条;覆盖软件开发与科研', () => {
    const catIds = new Set(CATALOG_CATEGORIES.map((c) => c.id));
    for (const e of CATALOG) expect(catIds.has(e.category)).toBe(true);
    for (const c of CATALOG_CATEGORIES) {
      expect(CATALOG.some((e) => e.category === c.id)).toBe(true);
    }
    expect(catIds.has('dev')).toBe(true);
    expect(catIds.has('research')).toBe(true);
  });
});

describe('listCatalog 过滤与排序', () => {
  it('默认按 stars 降序返回全部', () => {
    const all = listCatalog();
    expect(all.length).toBe(CATALOG.length);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].stars).toBeGreaterThanOrEqual(all[i].stars);
  });

  it('按分类过滤', () => {
    const dev = listCatalog({ category: 'dev' });
    expect(dev.length).toBeGreaterThan(0);
    expect(dev.every((e) => e.category === 'dev')).toBe(true);
    // 未知分类返回空,不抛异常
    expect(listCatalog({ category: 'nope' })).toEqual([]);
  });

  it('按关键词过滤(name/description/id,大小写不敏感)', () => {
    const first = CATALOG[0];
    const byName = listCatalog({ query: first.name.toUpperCase().slice(0, 4) });
    expect(byName.some((e) => e.id === first.id)).toBe(true);
    const byRepo = listCatalog({ query: first.id.split('/')[1] });
    expect(byRepo.some((e) => e.id === first.id)).toBe(true);
    expect(listCatalog({ query: '绝不可能命中的词xyz' })).toEqual([]);
  });
});

describe('listCatalogWithInstalled 标记', () => {
  it('空库时全部未安装', async () => {
    const items = await listCatalogWithInstalled();
    expect(items.length).toBe(CATALOG.length);
    expect(items.every((i) => !i.installed && i.installedCount === 0)).toBe(true);
  });

  it('registry 含该仓库条目时标记 installed 与计数(大小写不敏感)', async () => {
    const target = CATALOG[0];
    const mk = (sub: string): SkillEntry => ({
      id: `${target.id}:${sub}`,
      name: `s-${sub || 'root'}`,
      description: 'd',
      source: { type: 'github', uri: `https://github.com/${target.id}` },
      tags: [],
      installedAt: new Date().toISOString(),
    });
    await upsertSkill(mk(''));
    await upsertSkill(mk('sub-a'));
    // 其它仓库条目不影响
    await upsertSkill({ ...mk(''), id: 'other/repo:', source: { type: 'github', uri: 'https://github.com/other/repo' } });

    const items = await listCatalogWithInstalled();
    const hit = items.find((i) => i.id === target.id)!;
    expect(hit.installed).toBe(true);
    expect(hit.installedCount).toBe(2);
    expect(items.find((i) => i.id !== target.id && i.installed)).toBeUndefined();
  });

  it('过滤条件同样生效', async () => {
    const items = await listCatalogWithInstalled({ category: 'research' });
    expect(items.every((i) => i.category === 'research')).toBe(true);
  });

  it('MCP 条目:中央注册表有同名 server 即标记已添加', async () => {
    const target = CATALOG.find((e) => e.kind === 'mcp')!;
    await upsertMcp({ name: target.id, transport: 'stdio', command: 'npx' });
    const items = await listCatalogWithInstalled();
    const hit = items.find((i) => i.id === target.id)!;
    expect(hit.installed).toBe(true);
    expect(hit.installedCount).toBe(1);
    // 其它 MCP 条目不受影响
    expect(items.find((i) => i.kind === 'mcp' && i.id !== target.id && i.installed)).toBeUndefined();
  });
});

describe('listCatalogCategories 分类统计', () => {
  it('计数与 listCatalog 过滤一致,skill/MCP 细分之和等于总数,覆盖所有分类', () => {
    const cats = listCatalogCategories();
    expect(cats.map((c) => c.id)).toEqual(CATALOG_CATEGORIES.map((c) => c.id));
    let sum = 0;
    for (const c of cats) {
      const entries = listCatalog({ category: c.id });
      expect(c.count).toBe(entries.length);
      expect(c.count).toBeGreaterThan(0); // 分类无空档
      expect(c.skills + c.mcps).toBe(c.count);
      expect(c.skills).toBe(entries.filter((e) => e.kind !== 'mcp').length);
      sum += c.count;
    }
    expect(sum).toBe(CATALOG.length);
  });
});

/** 造一个假 skill 目录(SKILL.md 带合法 frontmatter) */
async function mkSkill(dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 描述\n---\n`, 'utf8');
}

describe('registerSkillsIn:合集仓库 subdir 扫描(推荐库安装链路)', () => {
  it('不传 subdir:只扫根 + 第一层;skills/ 下的二级 skill 不登记', async () => {
    const repo = path.join(tmp, 'repo');
    await mkSkill(repo, 'root-skill');
    await mkSkill(path.join(repo, 'other'), 'other-skill');
    await mkSkill(path.join(repo, 'skills', 'alpha'), 'alpha');
    const got = await registerSkillsIn(repo, 'o/r', 'https://github.com/o/r');
    expect(got.map((s) => s.id).sort()).toEqual(['o/r:', 'o/r:other']);
  });

  it('传 subdir=skills:以该子目录为扫描根,id 带 skills/ 前缀', async () => {
    const repo = path.join(tmp, 'repo');
    await mkSkill(repo, 'root-skill');
    await mkSkill(path.join(repo, 'skills', 'alpha'), 'alpha');
    await mkSkill(path.join(repo, 'skills', 'beta'), 'beta');
    await fs.mkdir(path.join(repo, 'skills', 'not-a-skill'), { recursive: true }); // 无 SKILL.md,跳过
    const got = await registerSkillsIn(repo, 'o/r', 'https://github.com/o/r', 'skills');
    expect(got.map((s) => s.id).sort()).toEqual(['o/r:skills/alpha', 'o/r:skills/beta']);
  });

  it('subdir 不存在时抛 LibraryError', async () => {
    const repo = path.join(tmp, 'repo');
    await mkSkill(repo, 'root-skill');
    await expect(registerSkillsIn(repo, 'o/r', 'u', 'missing')).rejects.toThrow(LibraryError);
  });

  it('installFromGithub 对非法 subdir 在 clone 前就拒绝(无网络也安全)', async () => {
    await expect(installFromGithub('owner/repo', '../etc')).rejects.toThrow('非法子目录');
    await expect(installFromGithub('owner/repo', 'a//b')).rejects.toThrow('非法子目录');
  });
});
