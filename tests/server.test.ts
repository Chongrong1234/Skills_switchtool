/**
 * server API 测试:起真实 HTTP 服务(listen 随机端口)验证校验逻辑与 CLI 对齐。
 */
import http, { type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(r.data.checks.map((c: { id: string }) => c.id)).toEqual(['ssw-home', 'git', 'agents', 'registry', 'projects', 'mcps', 'global']);
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
