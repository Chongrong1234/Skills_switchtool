/**
 * server API 测试:起真实 HTTP 服务(listen 随机端口)验证校验逻辑与 CLI 对齐。
 */
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
