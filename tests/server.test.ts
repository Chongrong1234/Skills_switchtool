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
});
