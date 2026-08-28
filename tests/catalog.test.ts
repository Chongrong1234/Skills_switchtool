/**
 * catalog 推荐库测试:数据完整性、过滤/排序、installed 标记。
 * 推荐库数据是内置静态数据,测试不访问网络;SSW_HOME 隔离仅服务于 registry 标记。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG,
  CATALOG_CATEGORIES,
  listCatalog,
  listCatalogWithInstalled,
} from '../src/core/catalog.js';
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
  it('条目非空且 id 无重复、格式为 owner/repo', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(15);
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) {
      expect(e.id).toMatch(/^[^/\s]+\/[^/\s]+$/);
      expect(e.stars).toBeGreaterThan(0);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.url).toBe(`https://github.com/${e.id}`);
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
});
