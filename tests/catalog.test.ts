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
  fetchGithubMcpConfig,
  listCatalog,
  listCatalogCategories,
  listCatalogWithInstalled,
  searchCatalogGithub,
  suggestMcpName,
} from '../src/core/catalog.js';
import { updateAiConfig } from '../src/core/ai.js';
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

  it('按 kind 分流:skill / mcp 互不混入,缺省 kind 视为 skill,两者合计为全部', () => {
    const skills = listCatalog({ kind: 'skill' });
    const mcps = listCatalog({ kind: 'mcp' });
    expect(skills.length).toBeGreaterThan(0);
    expect(mcps.length).toBeGreaterThan(0);
    expect(skills.every((e) => e.kind !== 'mcp')).toBe(true);
    expect(mcps.every((e) => e.kind === 'mcp')).toBe(true);
    expect(skills.length + mcps.length).toBe(CATALOG.length);
    // kind 与 category 可叠加
    const devMcps = listCatalog({ kind: 'mcp', category: 'dev' });
    expect(devMcps.every((e) => e.kind === 'mcp' && e.category === 'dev')).toBe(true);
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

// ---------- 推荐库联网搜索(searchCatalogGithub):网络层一律注入假 fetch,不访问真实 GitHub/模型 API ----------

/** 造一条 GitHub Search API 风格的仓库记录 */
function ghRepo(fullName: string, stars: number, description = `${fullName} 描述`): Record<string, unknown> {
  return {
    full_name: fullName,
    name: fullName.split('/')[1],
    html_url: `https://github.com/${fullName}`,
    stargazers_count: stars,
    description,
  };
}

/** 假 fetch:api.github.com 按查询词分发 byKeyword 里的仓库;chat/completions 返回 opts.chat;failGithub 时搜索全挂 */
function mockCatalogFetch(opts: { chat?: string; failGithub?: boolean; byKeyword?: Record<string, unknown[]>; ghQueries?: string[] }): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes('api.github.com')) {
      if (opts.ghQueries) opts.ghQueries.push(decodeURIComponent(u));
      if (opts.failGithub) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
      const q = decodeURIComponent(u.split('q=')[1]?.split('&')[0] ?? '');
      const kw = Object.keys(opts.byKeyword ?? {}).find((k) => q.includes(k));
      return { ok: true, status: 200, json: async () => ({ items: (kw && opts.byKeyword?.[kw]) ?? [] }), text: async () => '' };
    }
    if (u.includes('chat/completions')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: opts.chat ?? '{}' } }] }), text: async () => '' };
    }
    throw new Error(`unexpected url: ${u}`);
  }) as unknown as typeof fetch;
}

describe('searchCatalogGithub 联网搜索', () => {
  it('直连搜索:需求英文词兜底、star 降序、跨关键词去重、字段映射', async () => {
    const r = await searchCatalogGithub('react dashboard', {
      fetchImpl: mockCatalogFetch({
        byKeyword: {
          react: [ghRepo('b/react-skills', 50), ghRepo('a/shared', 10)],
          dashboard: [ghRepo('a/shared', 10), ghRepo('c/dash', 100)],
        },
      }),
    });
    expect(r.ai).toBe(false);
    expect(r.keywords).toEqual(['react', 'dashboard']);
    // star 降序 + 同名仓库跨关键词只出现一次
    expect(r.items.map((i) => i.repo)).toEqual(['c/dash', 'b/react-skills', 'a/shared']);
    expect(r.items.every((i) => !i.installed && i.installedCount === 0)).toBe(true);
    const shared = r.items[2];
    expect(shared.keyword).toBe('react'); // 记首个命中的关键词
    expect(shared.url).toBe('https://github.com/a/shared'); // 结果带仓库链接
  });

  it('已入库仓库标记 installed/installedCount,不排除', async () => {
    await upsertSkill({
      id: 'b/react-skills:x',
      name: 'x',
      description: 'd',
      source: { type: 'github', uri: 'https://github.com/b/react-skills' },
      tags: [],
      installedAt: new Date().toISOString(),
    });
    const r = await searchCatalogGithub('react', { fetchImpl: mockCatalogFetch({ byKeyword: { react: [ghRepo('b/react-skills', 5)] } }) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].installed).toBe(true);
    expect(r.items[0].installedCount).toBe(1);
  });

  it('ai 模式:模型提炼的关键词被采用(ai=true),GitHub 按这些词搜', async () => {
    await updateAiConfig({ baseUrl: 'https://relay.example.com/v1', model: 'm1', apiKey: 'sk-x' });
    const ghQueries: string[] = [];
    const r = await searchCatalogGithub('做个 PDF 处理工具', {
      ai: true,
      fetchImpl: mockCatalogFetch({ chat: '{"githubKeywords":["pdf"]}', ghQueries, byKeyword: { pdf: [ghRepo('p/pdf-tools', 9)] } }),
    });
    expect(r.ai).toBe(true);
    expect(r.keywords).toEqual(['pdf']);
    expect(r.model).toBe('m1');
    expect(ghQueries).toHaveLength(1);
    expect(ghQueries[0]).toContain('topic:agent-skills pdf');
    expect(r.items.map((i) => i.repo)).toEqual(['p/pdf-tools']);
  });

  it('ai 模式未配置 key:降级为兜底词直连(ai=false + message),搜索仍执行', async () => {
    const r = await searchCatalogGithub('react admin', {
      ai: true,
      fetchImpl: mockCatalogFetch({ byKeyword: { react: [ghRepo('b/react-skills', 5)] } }),
    });
    expect(r.ai).toBe(false);
    expect(r.message).toContain('未配置 AI');
    expect(r.keywords).toEqual(['react', 'admin']);
    expect(r.items.map((i) => i.repo)).toEqual(['b/react-skills']);
  });

  it('ai 模式模型调用失败:提炼降级,GitHub 搜索仍按兜底词返回结果', async () => {
    await updateAiConfig({ baseUrl: 'https://relay.example.com/v1', model: 'm1', apiKey: 'sk-x' });
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('chat/completions')) throw new Error('模型超时');
      if (u.includes('api.github.com')) {
        return { ok: true, status: 200, json: async () => ({ items: [ghRepo('r/x', 1)] }), text: async () => '' };
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;
    const r = await searchCatalogGithub('react 后台', { ai: true, fetchImpl });
    expect(r.ai).toBe(false);
    expect(r.message).toContain('AI 提炼关键词失败');
    expect(r.keywords).toEqual(['react']);
    expect(r.items.map((i) => i.repo)).toEqual(['r/x']);
  });

  it('GitHub 挂了:降级为空 + message,不抛异常', async () => {
    const r = await searchCatalogGithub('react', { fetchImpl: mockCatalogFetch({ failGithub: true }) });
    expect(r.items).toEqual([]);
    expect(r.message).toContain('GitHub 搜索不可用');
  });

  it('空查询:直接提示,不发任何请求', async () => {
    let called = 0;
    const r = await searchCatalogGithub('  ', { fetchImpl: (async () => { called++; throw new Error('x'); }) as unknown as typeof fetch });
    expect(r.items).toEqual([]);
    expect(r.message).toContain('请输入');
    expect(called).toBe(0);
  });
});

describe('searchCatalogGithub 联网搜索 MCP 仓库(kind=mcp)', () => {
  it('显式 kind=mcp:按 mcp-server/model-context-protocol 两个 topic 搜,合并去重,条目带 kind', async () => {
    const ghQueries: string[] = [];
    const r = await searchCatalogGithub('matlab', {
      kind: 'mcp',
      fetchImpl: mockCatalogFetch({
        ghQueries,
        byKeyword: { matlab: [ghRepo('matlab/matlab-mcp-server', 1442), ghRepo('jigarbhoye04/MatlabMCP', 19)] },
      }),
    });
    expect(r.kind).toBe('mcp');
    // 一个关键词 × 两个 MCP topic;两个 topic 返回同一批仓库,结果按 full_name 去重
    expect(ghQueries).toHaveLength(2);
    expect(ghQueries[0]).toContain('topic:mcp-server matlab');
    expect(ghQueries[1]).toContain('topic:model-context-protocol matlab');
    expect(r.items.map((i) => i.repo)).toEqual(['matlab/matlab-mcp-server', 'jigarbhoye04/MatlabMCP']);
    expect(r.items.every((i) => i.kind === 'mcp' && !i.installed)).toBe(true);
  });

  it('搜索词含独立单词 mcp 时自动按 mcp 搜;裸 mcp 词不参与检索', async () => {
    const ghQueries: string[] = [];
    const r = await searchCatalogGithub('matlab mcp', {
      fetchImpl: mockCatalogFetch({ ghQueries, byKeyword: { matlab: [ghRepo('matlab/matlab-mcp-server', 1442)] } }),
    });
    expect(r.kind).toBe('mcp');
    // 兜底关键词是 ["matlab","mcp"],裸 "mcp" 被滤掉,只按 matlab 搜两个 topic
    expect(ghQueries).toHaveLength(2);
    expect(ghQueries[0]).toContain('topic:mcp-server matlab');
    expect(ghQueries[1]).toContain('topic:model-context-protocol matlab');
    expect(r.items.map((i) => i.repo)).toEqual(['matlab/matlab-mcp-server']);
  });

  it('kind=mcp 时 installed 按 mcps.json 里的建议 server 名判定(大小写不敏感)', async () => {
    await upsertMcp({ name: 'MatlabMCP', command: 'python server.py' });
    const r = await searchCatalogGithub('matlab', {
      kind: 'mcp',
      fetchImpl: mockCatalogFetch({
        byKeyword: { matlab: [ghRepo('matlab/matlab-mcp-server', 1442), ghRepo('jigarbhoye04/MatlabMCP', 19)] },
      }),
    });
    // MatlabMCP 仓库名建议名即 MatlabMCP,与注册表条目同名 → 标记已添加;另一个未添加
    const byRepo = Object.fromEntries(r.items.map((i) => [i.repo, i]));
    expect(byRepo['jigarbhoye04/MatlabMCP'].installed).toBe(true);
    expect(byRepo['matlab/matlab-mcp-server'].installed).toBe(false);
  });

  it('skill 口径不受影响:显式 kind=skill 仍只搜 agent-skills topic,即使搜索词含 mcp', async () => {
    const ghQueries: string[] = [];
    const r = await searchCatalogGithub('matlab mcp', { kind: 'skill', fetchImpl: mockCatalogFetch({ ghQueries, byKeyword: {} }) });
    expect(r.kind).toBe('skill');
    expect(ghQueries.length).toBeGreaterThan(0);
    expect(ghQueries.every((u) => u.includes('topic:agent-skills'))).toBe(true);
  });
});

// ---------- fetchGithubMcpConfig:从仓库 README 提取 MCP 启动配置;网络层注入假 fetch ----------

/** 假 fetch:只回答 api.github.com/repos/<repo>/readme,返回 base64 的 README;status 指定时按错误响应 */
function mockReadmeFetch(readme: string, opts: { status?: number } = {}): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes('api.github.com/repos/') && u.endsWith('/readme')) {
      if (opts.status) return { ok: false, status: opts.status, json: async () => ({}), text: async () => '' };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: Buffer.from(readme, 'utf8').toString('base64'), encoding: 'base64' }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected url: ${u}`);
  }) as unknown as typeof fetch;
}

describe('fetchGithubMcpConfig 从 README 提取 MCP 配置', () => {
  it('mcpServers JSON 块 → stdio 配置(command/args/env;非字符串 env 值被丢弃)', async () => {
    const md = [
      '# Filesystem MCP', '',
      '```json',
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { API_KEY: 'YOUR_KEY', PORT: 8080 },
          },
        },
      }),
      '```',
    ].join('\n');
    const r = await fetchGithubMcpConfig('modelcontextprotocol/servers', mockReadmeFetch(md));
    expect(r.repo).toBe('modelcontextprotocol/servers');
    expect(r.name).toBe('servers');
    expect(r.message).toBeUndefined();
    expect(r.spec).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { API_KEY: 'YOUR_KEY' },
    });
  });

  it('VS Code 风格 servers 键也识别;多 server 时优先与仓库名相近的条目', async () => {
    const md = [
      '```json',
      JSON.stringify({
        servers: {
          unrelated: { command: 'npx', args: ['-y', 'other'] },
          matlab: { type: 'stdio', command: '/opt/matlab-mcp-server', args: [] },
        },
      }),
      '```',
    ].join('\n');
    const r = await fetchGithubMcpConfig('matlab/matlab-mcp-server', mockReadmeFetch(md));
    expect(r.name).toBe('matlab-mcp-server');
    expect(r.spec).toEqual({ transport: 'stdio', command: '/opt/matlab-mcp-server', args: [], env: undefined });
  });

  it('远端条目:url + type=sse → sse 配置带 headers', async () => {
    const md = ['```json', JSON.stringify({ mcpServers: { r: { type: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer x' } } } }), '```'].join('\n');
    const r = await fetchGithubMcpConfig('a/b', mockReadmeFetch(md));
    expect(r.spec).toEqual({ transport: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer x' } });
  });

  it('README 无配置块:降级 spec=null + message,不抛异常', async () => {
    const r = await fetchGithubMcpConfig('a/b', mockReadmeFetch('# 纯文字 README\n没有任何配置块\n```sh\nnpm install\n```\n'));
    expect(r.spec).toBeNull();
    expect(r.message).toContain('mcpServers');
  });

  it('仓库格式非法:抛 McpError(→400),不发网络请求', async () => {
    let called = 0;
    await expect(
      fetchGithubMcpConfig('not a repo', (async () => { called++; throw new Error('x'); }) as unknown as typeof fetch),
    ).rejects.toThrow('格式非法');
    expect(called).toBe(0);
  });

  it('GitHub 404 / 网络异常:降级 spec=null + message,不抛异常', async () => {
    const r404 = await fetchGithubMcpConfig('a/b', mockReadmeFetch('', { status: 404 }));
    expect(r404.spec).toBeNull();
    expect(r404.message).toContain('404');
    const rNet = await fetchGithubMcpConfig('a/b', (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch);
    expect(rNet.spec).toBeNull();
    expect(rNet.message).toContain('网络不可用');
  });
});

describe('suggestMcpName server 名清洗', () => {
  it('合法名原样保留;非法字符转 - 并收敛;空结果兜底;截断 64', () => {
    expect(suggestMcpName('matlab-mcp-server')).toBe('matlab-mcp-server');
    expect(suggestMcpName('MCP.Server  2')).toBe('MCP-Server-2');
    expect(suggestMcpName('---')).toBe('mcp-server');
    expect(suggestMcpName('x'.repeat(80))).toHaveLength(64);
  });
});
