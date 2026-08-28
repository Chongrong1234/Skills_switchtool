/**
 * recommend 测试:技术栈检测单测 + 网络层 mock(不访问真实 GitHub)。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectTechStack, recommendForProject } from '../src/core/recommend.js';

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

describe('detectTechStack', () => {
  it('package.json → node', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{"name":"x"}', 'utf8');
    expect(await detectTechStack(tmp)).toEqual(['node']);
  });

  it('package.json 含 typescript 依赖 → node + typescript', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '^5' } }),
      'utf8',
    );
    expect(await detectTechStack(tmp)).toEqual(['node', 'typescript']);
  });

  it('tsconfig.json 存在也算 typescript', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    await fs.writeFile(path.join(tmp, 'tsconfig.json'), '{}', 'utf8');
    expect(await detectTechStack(tmp)).toEqual(['node', 'typescript']);
  });

  it('go.mod / Cargo.toml / pyproject.toml', async () => {
    await fs.writeFile(path.join(tmp, 'go.mod'), 'module x', 'utf8');
    expect(await detectTechStack(tmp)).toEqual(['go']);

    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-rs-'));
    await fs.writeFile(path.join(tmp2, 'Cargo.toml'), '[package]', 'utf8');
    expect(await detectTechStack(tmp2)).toEqual(['rust']);
    await fs.rm(tmp2, { recursive: true, force: true });

    const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-py-'));
    await fs.writeFile(path.join(tmp3, 'pyproject.toml'), '[project]', 'utf8');
    expect(await detectTechStack(tmp3)).toEqual(['python']);
    await fs.rm(tmp3, { recursive: true, force: true });
  });

  it('空目录 → 空数组', async () => {
    expect(await detectTechStack(tmp)).toEqual([]);
  });
});

function mockGithubFetch(items: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items }),
  })) as unknown as typeof fetch;
}

describe('recommendForProject(网络层 mock)', () => {
  const repos = [
    {
      full_name: 'alice/node-skills',
      name: 'node-skills',
      html_url: 'https://github.com/alice/node-skills',
      stargazers_count: 100,
      description: 'skills for node developers',
    },
    {
      full_name: 'bob/mega-skills',
      name: 'mega-skills',
      html_url: 'https://github.com/bob/mega-skills',
      stargazers_count: 5000,
      description: 'all-in-one agent skills',
    },
  ];

  it('返回按 stars 降序的推荐,reason 命中技术栈', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    const fetchImpl = mockGithubFetch(repos);
    const result = await recommendForProject(tmp, 'my node app', fetchImpl);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].repo).toBe('bob/mega-skills'); // star 高的在前
    expect(result.items[0].stars).toBe(5000);
    expect(result.items[1].reason).toContain('node');
  });

  it('断网时降级为空数组 + 说明,绝不抛异常', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;
    const result = await recommendForProject(tmp, 'offline project', fetchImpl);
    expect(result.items).toEqual([]);
    expect(result.message).toContain('降级');
  });

  it('限流(403)同样降级不抛异常', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await recommendForProject(tmp, 'rate limited', fetchImpl);
    expect(result.items).toEqual([]);
    expect(result.message).toBeTruthy();
  });

  it('第二次相同查询走缓存,不再请求网络', async () => {
    const fetchImpl = mockGithubFetch(repos);
    const r1 = await recommendForProject(tmp, 'cache test project', fetchImpl);
    const r2 = await recommendForProject(tmp, 'cache test project', fetchImpl);
    expect(r1.items).toHaveLength(2);
    expect(r2.items).toHaveLength(2);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
