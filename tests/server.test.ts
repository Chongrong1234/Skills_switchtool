/**
 * server API 测试:起真实 HTTP 服务(listen 随机端口)验证校验逻辑与 CLI 对齐。
 */
import http, { type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_FORMAT } from '../src/core/profile.js';
import { createApp } from '../src/server.js';

let tmp: string;
let server: Server;
let base: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

describe('server 校验(与 CLI 行为对齐)', () => {
  it('创建项目时拒绝未知 agent', async () => {
    const r = await api('POST', '/api/projects', { name: 'x', path: '/tmp/x', agents: ['ghost-agent'] });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('未知 agent');
  });

  it('创建项目省略 path 时取服务进程 cwd;/api/meta 暴露 cwd', async () => {
    const meta = await api('GET', '/api/meta');
    expect(meta.status).toBe(200);
    expect(meta.data.cwd).toBe(process.cwd());
    const c = await api('POST', '/api/projects', { name: 'x', agents: [] });
    expect(c.status).toBe(201);
    expect(c.data.path).toBe(process.cwd());
    // name 仍是必填
    const bad = await api('POST', '/api/projects', { path: '/tmp/x' });
    expect(bad.status).toBe(400);
  });

  it('GET /api/doctor 返回环境自检报告(与 ssw doctor 同一份)', async () => {
    const r = await api('GET', '/api/doctor');
    expect(r.status).toBe(200);
    expect(typeof r.data.version).toBe('string');
    expect(r.data.ok).toBe(true);
    expect(r.data.sswHome).toBe(tmp);
    expect(r.data.checks.map((c: { id: string }) => c.id)).toEqual(['ssw-home', 'git', 'agents', 'registry', 'projects', 'mcps', 'global', 'update']);
    expect(r.data.stats).toEqual({ skills: 0, mcps: 0, projects: 0, activeProject: null });
  });

  it('绑定不存在的 skillId 返回 400', async () => {
    const c = await api('POST', '/api/projects', { name: 'x', path: '/tmp/x', agents: [] });
    expect(c.status).toBe(201);
    const r = await api('POST', `/api/projects/${c.data.id}/skills`, { skillIds: ['local:ghost'] });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('库中不存在');
    // 未写入
    const g = await api('GET', `/api/projects/${c.data.id}`);
    expect(g.data.skills).toEqual([]);
  });

  it('PATCH skills / agents 同样校验', async () => {
    const c = await api('POST', '/api/projects', { name: 'x', path: '/tmp/x', agents: [] });
    const badSkills = await api('PATCH', `/api/projects/${c.data.id}`, { skills: ['local:ghost'] });
    expect(badSkills.status).toBe(400);
    const badAgents = await api('PATCH', `/api/projects/${c.data.id}`, { agents: ['ghost-agent'] });
    expect(badAgents.status).toBe(400);
    expect(badAgents.data.error).toContain('未知 agent');
  });

  it('正常创建与绑定仍工作(回归)', async () => {
    const init = await api('POST', '/api/skills/init', { name: 'srv-skill', description: 'd' });
    expect(init.status).toBe(201);
    const c = await api('POST', '/api/projects', { name: 'x', path: '/tmp/x', agents: ['claude-code'] });
    expect(c.status).toBe(201);
    const bind = await api('POST', `/api/projects/${c.data.id}/skills`, { skillIds: [init.data.id] });
    expect(bind.status).toBe(200);
    expect(bind.data.skills).toEqual([init.data.id]);
  });

  it('skills/init 支持粘贴内容:frontmatter 兜底 name/description;content 非字符串 400', async () => {
    // 只贴完整 SKILL.md,不带 name/description → 由 frontmatter 兜底
    const only = await api('POST', '/api/skills/init', {
      content: '---\nname: pasted-via-api\ndescription: 接口粘贴\n---\n\n# 正文\n',
    });
    expect(only.status).toBe(201);
    expect(only.data.id).toBe('local:pasted-via-api');
    expect(only.data.description).toBe('接口粘贴');
    // content 非字符串 → 400;既无 name/desc 又无 content → 400(校验错误经 LibraryError 映射)
    expect((await api('POST', '/api/skills/init', { name: 'x', description: 'y', content: 1 })).status).toBe(400);
    expect((await api('POST', '/api/skills/init', {})).status).toBe(400);
  });

  it('MCP 端点:add/list/bind/delete 全流程 + 校验', async () => {
    // 缺 name → 400;stdio 缺 command → 400(McpError 映射)
    expect((await api('POST', '/api/mcps', { command: 'npx' })).status).toBe(400);
    const bad = await api('POST', '/api/mcps', { name: 'x', transport: 'stdio' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('command');

    const add = await api('POST', '/api/mcps', { name: 'fs', command: 'npx', args: ['-y', 'pkg'] });
    expect(add.status).toBe(201);
    expect(add.data.transport).toBe('stdio');
    expect((await api('GET', '/api/mcps')).data).toHaveLength(1);

    // 同名再 POST = 更新配置(GUI「设置」按钮走的就是这条 upsert 路径),addedAt 保留首次添加时间
    const upd = await api('POST', '/api/mcps', { name: 'fs', command: 'bunx', env: { K: 'V' } });
    expect(upd.status).toBe(201);
    expect(upd.data.command).toBe('bunx');
    expect(upd.data.args).toBeUndefined();
    expect(upd.data.addedAt).toBe(add.data.addedAt);
    expect((await api('GET', '/api/mcps')).data).toHaveLength(1);

    const c = await api('POST', '/api/projects', { name: 'x', path: '/tmp/x', agents: ['claude-code'] });
    // 绑定不存在的 server → 400
    const badBind = await api('POST', `/api/projects/${c.data.id}/mcps`, { mcpNames: ['ghost'] });
    expect(badBind.status).toBe(400);
    expect(badBind.data.error).toContain('MCP server');
    // 正常绑定
    const bind = await api('POST', `/api/projects/${c.data.id}/mcps`, { mcpNames: ['fs'] });
    expect(bind.status).toBe(200);
    expect(bind.data.mcps).toEqual(['fs']);
    // PATCH mcps 同样校验
    expect((await api('PATCH', `/api/projects/${c.data.id}`, { mcps: ['ghost'] })).status).toBe(400);
    // 删除 server 后项目绑定被解除
    expect((await api('DELETE', '/api/mcps/fs')).status).toBe(200);
    expect((await api('GET', `/api/projects/${c.data.id}`)).data.mcps).toEqual([]);
    expect((await api('DELETE', '/api/mcps/fs')).status).toBe(404);
  });

  it('global 端点:默认档案、PUT 校验与回写', async () => {
    const def = await api('GET', '/api/global');
    expect(def.status).toBe(200);
    expect(def.data).toMatchObject({ skills: [], agents: [], applyMode: 'symlink' });

    expect((await api('PUT', '/api/global', { applyMode: 'zip' })).status).toBe(400);
    const badAgents = await api('PUT', '/api/global', { agents: ['ghost-agent'] });
    expect(badAgents.status).toBe(400);
    expect(badAgents.data.error).toContain('未知 agent');
    expect((await api('PUT', '/api/global', { skills: ['local:ghost'] })).status).toBe(400);

    const ok = await api('PUT', '/api/global', { agents: ['claude-code'], applyMode: 'copy' });
    expect(ok.status).toBe(200);
    expect(ok.data.agents).toEqual(['claude-code']);
    expect(ok.data.applyMode).toBe('copy');
    // 不写 apply 端点:它会物化到真实用户级目录,api 层只验证档案读写与校验
  });

  it('skills adopt 端点:校验与空目录', async () => {
    expect((await api('POST', '/api/skills/adopt', {})).status).toBe(400);
    const unknown = await api('POST', '/api/skills/adopt', { agent: 'ghost-agent' });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toContain('未知 agent');
    const projDir = path.join(tmp, 'proj');
    await fs.mkdir(path.join(projDir, '.claude', 'skills'), { recursive: true });
    const ok = await api('POST', '/api/skills/adopt', { agent: 'claude-code', scope: 'project', projectPath: projDir });
    expect(ok.status).toBe(200);
    expect(ok.data.adopted).toEqual([]);

    // all:true 一键收养所有 agent(分目录结构;非法 scope 同样 400)
    const all = await api('POST', '/api/skills/adopt', { all: true, scope: 'project', projectPath: projDir });
    expect(all.status).toBe(200);
    expect(Array.isArray(all.data.scanned)).toBe(true);
    expect(Array.isArray(all.data.skippedAgents)).toBe(true);
    expect((await api('POST', '/api/skills/adopt', { all: true, scope: 'nope' })).status).toBe(400);
  });

  it('profile 端点:导出格式、导入校验', async () => {
    const exp = await api('GET', '/api/profile/export');
    expect(exp.status).toBe(200);
    expect(exp.data.bundle.format).toBe('ssw-profile@1');
    expect(Array.isArray(exp.data.bundle.skills)).toBe(true);

    expect((await api('POST', '/api/profile/import', {})).status).toBe(400);
    const bad = await api('POST', '/api/profile/import', { bundle: { format: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('profile 格式');
    // 空 profile 导入(无 github 来源,不碰网络)是合法空操作
    const empty = await api('POST', '/api/profile/import', {
      bundle: { format: 'ssw-profile@1', skills: [], mcps: [], projects: { activeProjectId: null, projects: [] }, global: { skills: [], agents: [], applyMode: 'symlink' }, localFiles: {} },
    });
    expect(empty.status).toBe(200);
    expect(empty.data.installedRepos).toEqual([]);
  });

  it('GET /api/progress:空闲时返回空任务列表(GUI 进度条轮询端点)', async () => {
    const r = await api('GET', '/api/progress');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ jobs: [] });
  });

  it('GET /api/catalog:分类带条目统计,count 之和等于条目总数;category 过滤生效', async () => {
    const r = await api('GET', '/api/catalog');
    expect(r.status).toBe(200);
    expect(r.data.categories.length).toBeGreaterThan(0);
    for (const c of r.data.categories) {
      expect(typeof c.count).toBe('number');
      expect(c.count).toBe(c.skills + c.mcps);
    }
    const total = r.data.categories.reduce((n: number, c: { count: number }) => n + c.count, 0);
    expect(total).toBe(r.data.items.length);
    // 分类过滤:只含该分类条目
    const devId = r.data.categories[0].id;
    const filtered = await api('GET', `/api/catalog?category=${devId}`);
    expect(filtered.data.items.every((e: { category: string }) => e.category === devId)).toBe(true);
  });

  it('GET /api/catalog?kind=:skills 与 MCP 分流,互不混入;非法 kind 400', async () => {
    const skills = await api('GET', '/api/catalog?kind=skill');
    expect(skills.status).toBe(200);
    expect(skills.data.items.length).toBeGreaterThan(0);
    expect(skills.data.items.every((e: { kind?: string }) => e.kind !== 'mcp')).toBe(true);
    const mcps = await api('GET', '/api/catalog?kind=mcp');
    expect(mcps.status).toBe(200);
    expect(mcps.data.items.length).toBeGreaterThan(0);
    expect(mcps.data.items.every((e: { kind?: string }) => e.kind === 'mcp')).toBe(true);
    // 两类合计 = 不带 kind 的全部条目
    const all = await api('GET', '/api/catalog');
    expect(skills.data.items.length + mcps.data.items.length).toBe(all.data.items.length);
    const bad = await api('GET', '/api/catalog?kind=nope');
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('kind');
  });

  it('GET /api/catalog/github:q 必填;联网搜索结果带链接/installed 标记(GitHub API 走假 fetch)', async () => {
    // q 缺失或全空白 → 400
    expect((await api('GET', '/api/catalog/github')).status).toBe(400);
    expect((await api('GET', '/api/catalog/github?q=%20')).status).toBe(400);

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.github.com/search/repositories')) {
        return new Response(JSON.stringify({ items: [
          { full_name: 'x/pdf-skills', name: 'pdf-skills', html_url: 'https://github.com/x/pdf-skills', stargazers_count: 42, description: 'pdf 技能' },
        ] }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch);
    try {
      const r = await api('GET', '/api/catalog/github?q=pdf');
      expect(r.status).toBe(200);
      expect(r.data.items).toHaveLength(1);
      expect(r.data.items[0].repo).toBe('x/pdf-skills');
      expect(r.data.items[0].url).toBe('https://github.com/x/pdf-skills');
      expect(r.data.items[0].installed).toBe(false);
      expect(r.data.ai).toBe(false);
      // ai=1 未配置 key:降级直连,仍 200 返回(message 说明,不抛错)
      const degraded = await api('GET', '/api/catalog/github?q=pdf&ai=1');
      expect(degraded.status).toBe(200);
      expect(degraded.data.ai).toBe(false);
      expect(degraded.data.message).toContain('未配置 AI');
      expect(degraded.data.items).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('AI 端点:配置读写掩码不回原文;非法 baseUrl 400;recommend 校验与降级', async () => {
    // 初始:未配置 key,带预设清单,不含 apiKey 原文字段
    const init = await api('GET', '/api/ai/config');
    expect(init.status).toBe(200);
    expect(init.data.hasKey).toBe(false);
    expect(Array.isArray(init.data.presets)).toBe(true);
    expect('apiKey' in init.data).toBe(false);

    // 保存配置:返回掩码;再 GET 读回
    const put = await api('PUT', '/api/ai/config', { baseUrl: 'https://relay.example.com/v1', model: 'm1', apiKey: 'sk-live-4321' });
    expect(put.status).toBe(200);
    expect(put.data.apiKeyMask).toBe('••••4321');
    const got = await api('GET', '/api/ai/config');
    expect(got.data.model).toBe('m1');
    expect(JSON.stringify(got.data)).not.toContain('sk-live-4321');

    // 非法 baseUrl → 400;字段类型错 → 400
    expect((await api('PUT', '/api/ai/config', { baseUrl: 'not-a-url' })).status).toBe(400);
    expect((await api('PUT', '/api/ai/config', { model: 1 })).status).toBe(400);

    // recommend:requirement 必填;库里没 skill 时降级 message 而不是报错
    expect((await api('POST', '/api/ai/recommend', {})).status).toBe(400);
    const rec = await api('POST', '/api/ai/recommend', { requirement: '做个后台系统' });
    expect(rec.status).toBe(200);
    expect(rec.data.items).toEqual([]);
    expect(rec.data.message).toContain('技能库为空');

    // test 端点不配置代理 fetch 会真实发请求——只断言它对缺 key 的短路
    // (真实网络路径由 tests/ai.test.ts 的注入 fetch 覆盖)
  });

  it('GET /api/skills?rank=1:热度排序(常用优先);forProject 带项目上下文;坏项目 404', async () => {
    // 造两个 skill:一个"绑定过",一个全新的
    const a = await api('POST', '/api/skills/init', { name: 'used-one', description: 'node 工具' });
    const b = await api('POST', '/api/skills/init', { name: 'fresh-one', description: '新技能' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const c = await api('POST', '/api/projects', { name: 'rank-proj', path: '/tmp/x', agents: [] });
    await api('POST', `/api/projects/${c.data.id}/skills`, { skillIds: [a.data.id] }); // 计一次使用
    await api('POST', `/api/projects/${c.data.id}/skills`, { skillIds: [] });          // 解绑不扣热度

    const ranked = await api('GET', '/api/skills?rank=1');
    expect(ranked.status).toBe(200);
    expect(ranked.data[0].id).toBe(a.data.id); // 用过的排最前
    expect(ranked.data[0].useCount).toBe(1);

    const withCtx = await api('GET', `/api/skills?rank=1&forProject=${c.data.id}`);
    expect(withCtx.status).toBe(200);
    expect((await api('GET', '/api/skills?rank=1&forProject=ghost')).status).toBe(404);
    // 默认不带 rank 仍是注册表原顺序(向后兼容)
    const plain = await api('GET', '/api/skills');
    expect(plain.status).toBe(200);
    expect(plain.data.map((s: { id: string }) => s.id)).toEqual([a.data.id, b.data.id]);
  });
});

describe('回环防护(无认证服务的边界)', () => {
  it('Host 非回环 → 403(防 DNS rebinding)', async () => {
    // undici 禁改 Host 头,走原生 http
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(base);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: '/api/projects', method: 'GET', headers: { Host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('带跨站 Origin → 403;回环源(Electron 页面自身)放行;无 Origin(curl/CLI)放行', async () => {
    const evil = await fetch(`${base}/api/projects`, { headers: { Origin: 'https://evil.example.com' } });
    expect(evil.status).toBe(403);
    const own = await fetch(`${base}/api/projects`, { headers: { Origin: base } });
    expect(own.status).toBe(200);
    const bare = await api('GET', '/api/projects');
    expect(bare.status).toBe(200);
  });
});

describe('profile 导入大 bundle(express.json 默认 100KB 曾把 GUI 导入 413 掉)', () => {
  it('超过 100KB 的 bundle 可正常导入', async () => {
    const big = Buffer.alloc(200 * 1024, 0x61).toString('base64'); // ≈267KB
    const bundle = {
      format: PROFILE_FORMAT,
      exportedAt: new Date().toISOString(),
      skills: [],
      mcps: [],
      projects: { projects: [], activeProjectId: null },
      global: { skills: [], agents: [], applyMode: 'symlink' },
      localFiles: { junk: { 'a.txt': big } }, // 无对应 skill 条目,内容不被触碰
    };
    const r = await api('POST', '/api/profile/import', { bundle });
    expect(r.status).toBe(200);
    expect(r.data.warnings).toEqual([]);
  });
});

describe('软件更新端点(GitHub API 走假 fetch,其余请求代理回真实 fetch)', () => {
  const fakeRelease = {
    tag_name: 'v99.0.0',
    html_url: 'https://github.com/Chongrong1234/Skills_switchtool/releases/tag/v99.0.0',
    published_at: '2026-09-01T00:00:00Z',
    // 资产覆盖三平台且名字共享 'Skills.SwitchTool-99.0.0' 前缀:pickAsset 按运行平台挑,
    // 只放 AppImage 时 mac/win 挑不到资产,download 会 400 而不是 202
    assets: [
      {
        name: 'Skills.SwitchTool-99.0.0.AppImage',
        browser_download_url: 'https://fake.test/dl.AppImage',
        size: 9,
      },
      {
        name: 'Skills.SwitchTool-99.0.0.Setup.exe',
        browser_download_url: 'https://fake.test/dl.exe',
        size: 9,
      },
      {
        name: 'Skills.SwitchTool-99.0.0-arm64.dmg',
        browser_download_url: 'https://fake.test/dl-arm64.dmg',
        size: 9,
      },
      {
        name: 'Skills.SwitchTool-99.0.0.dmg',
        browser_download_url: 'https://fake.test/dl-x64.dmg',
        size: 9,
      },
    ],
  };

  function stubGithubFetch(): void {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify(fakeRelease), { status: 200 });
      }
      if (url.startsWith('https://fake.test/')) {
        return new Response('hello-app', { status: 200, headers: { 'content-length': '9' } });
      }
      return realFetch(input, init);
    }) as typeof fetch);
  }

  // 注意:本用例依赖"进程内尚无成功检查结果"(update.ts 的 lastResult 是模块级状态),
  // 必须定义在本 describe 最前面——vitest 同文件内按定义顺序执行
  it('尚未检查过且检查失败时,download 返回 502(不建任务)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.github.com')) return new Response('x', { status: 503 });
      return realFetch(input, init);
    }) as typeof fetch);
    try {
      const dl = await api('POST', '/api/update/download', {});
      expect(dl.status).toBe(502);
      expect(dl.data.error).toContain('检查更新失败');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('status/config/check/download/open 全链路', async () => {
    stubGithubFetch();
    try {
      // 状态:默认配置(软件自动检查开/自动下载关,技能库定时检查开),不发网络请求
      const st0 = await api('GET', '/api/update/status');
      expect(st0.status).toBe(200);
      expect(typeof st0.data.current).toBe('string');
      expect(st0.data.config).toEqual({
        autoCheck: true,
        autoDownload: false,
        skillsAutoCheck: true,
        skillsCheckIntervalHours: 6,
      });

      // 配置写回 + 类型错误 400
      const cfg = await api('PUT', '/api/update/config', { autoDownload: true, skillsAutoCheck: false });
      expect(cfg.status).toBe(200);
      expect(cfg.data).toEqual({ autoCheck: true, autoDownload: true, skillsAutoCheck: false, skillsCheckIntervalHours: 6 });
      expect((await api('PUT', '/api/update/config', { autoCheck: 'yes' })).status).toBe(400);
      expect((await api('PUT', '/api/update/config', { skillsCheckIntervalHours: '6' })).status).toBe(400);

      // 手动检查(强制):发现新版本;三平台都要能挑到资产(夹具资产覆盖全平台)
      const chk = await api('POST', '/api/update/check', {});
      expect(chk.status).toBe(200);
      expect(chk.data.ok).toBe(true);
      expect(chk.data.hasUpdate).toBe(true);
      expect(chk.data.latest).toBe('99.0.0');
      expect(chk.data.asset?.name).toContain('Skills.SwitchTool-99.0.0');

      // status 现在带最近检查结果
      const st1 = await api('GET', '/api/update/status');
      expect(st1.data.last?.hasUpdate).toBe(true);

      // open:非法 target 400(成功路径会 spawn 系统打开器,CI 未必有 xdg-open,不断言)
      const badOpen = await api('POST', '/api/update/open', { target: 'nope' });
      expect(badOpen.status).toBe(400);

      // download:202 异步开始;轮询 status 到完成;文件落在数据目录 downloads/
      const dl = await api('POST', '/api/update/download', {});
      expect(dl.status).toBe(202);
      expect(dl.data.started).toBe(true);
      let job: { done: boolean; error?: string; file?: string } | null = null;
      for (let i = 0; i < 100; i++) {
        const s = await api('GET', '/api/update/status');
        job = s.data.download;
        if (job?.done) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(job?.done).toBe(true);
      expect(job?.error).toBeUndefined();
      // 挑中的资产名随平台不同(AppImage/Setup.exe/dmg),共同前缀是 Skills.SwitchTool-99.0.0
      expect(job?.file).toContain('Skills.SwitchTool-99.0.0');
      expect(await fs.readFile(job!.file!, 'utf8')).toBe('hello-app');

      // 同一文件已完整下载过 → 幂等 already,不重复拉
      const again = await api('POST', '/api/update/download', {});
      expect(again.status).toBe(200);
      expect(again.data.already).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('技能库更新端点(本地 git 仓库模拟远程,不打真实 GitHub)', () => {
  const execFileP = promisify(execFile);
  const git = (args: string[]) => execFileP('git', args);

  /** 造本地"远程"仓库(bare)+ 工作克隆,把克隆放进库目录并写注册表条目 */
  async function seedLibraryClone(ownerRepo: string): Promise<{ workDir: string }> {
    const [owner, repo] = ownerRepo.split('/');
    const remoteDir = path.join(tmp, `remote-${owner}-${repo}.git`);
    const workDir = path.join(tmp, `work-${owner}-${repo}`);
    await git(['init', '--bare', '-b', 'main', remoteDir]);
    await git(['init', '-b', 'main', workDir]);
    await fs.mkdir(path.join(workDir, 'demo'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\n# demo\n');
    await git(['-C', workDir, 'add', '.']);
    await git(['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
    await git(['-C', workDir, 'remote', 'add', 'origin', remoteDir]);
    await git(['-C', workDir, 'push', '-u', 'origin', 'main']);
    await git(['clone', remoteDir, path.join(tmp, 'library', `github__${owner}__${repo}`)]);
    await fs.writeFile(
      path.join(tmp, 'registry.json'),
      JSON.stringify({
        skills: [
          {
            id: `${ownerRepo}:demo`,
            name: 'demo',
            description: 'd',
            source: { type: 'github', uri: ownerRepo },
            tags: [],
            installedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    return { workDir };
  }

  it('status/check/apply 全链路 + repoIds 校验', async () => {
    // apply 里 updateSkill 会顺带刷 stars:短路 api.github.com,localhost 走真实 fetch
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('api.github.com')) return new Response('{}', { status: 404 });
      return realFetch(input, init);
    }) as typeof fetch);
    try {
      // 还没检查过:last 为 null,不发网络
      const st0 = await api('GET', '/api/skills/updates');
      expect(st0.status).toBe(200);
      expect(st0.data.last).toBeNull();

      const { workDir } = await seedLibraryClone('o/srv-upd');

      // 手动检查:behind 0
      const c1 = await api('POST', '/api/skills/updates/check');
      expect(c1.status).toBe(200);
      expect(c1.data.ok).toBe(true);
      expect(c1.data.updates[0]).toMatchObject({ repoId: 'o/srv-upd', behind: 0 });

      // 上游推一个新提交后再查:behind 1
      await fs.writeFile(path.join(workDir, 'demo', 'new.md'), 'x');
      await git(['-C', workDir, 'add', '.']);
      await git(['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v2']);
      await git(['-C', workDir, 'push']);
      const c2 = await api('POST', '/api/skills/updates/check');
      expect(c2.data.updates[0].behind).toBe(1);
      expect((await api('GET', '/api/skills/updates')).data.last.updates[0].behind).toBe(1);

      // repoIds 校验:非字符串数组 400
      expect((await api('POST', '/api/skills/updates/apply', { repoIds: 'x' })).status).toBe(400);

      // 一键更新:更新成功,库内拿到新文件,状态里 behind 清零
      const ap = await api('POST', '/api/skills/updates/apply', {});
      expect(ap.status).toBe(200);
      expect(ap.data.updated).toEqual(['o/srv-upd:demo']);
      expect(ap.data.failed).toEqual([]);
      expect(await fs.readFile(path.join(tmp, 'library', 'github__o__srv-upd', 'demo', 'new.md'), 'utf8')).toBe('x');
      expect((await api('GET', '/api/skills/updates')).data.last.updates[0].behind).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
