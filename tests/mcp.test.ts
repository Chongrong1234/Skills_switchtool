/**
 * MCP 管理测试:注册表校验、项目绑定、apply/unapply/rollback(JSON 系 + codex TOML)。
 * 与 apply.test.ts 同隔离约定:SSW_HOME 指向 mkdtemp 临时目录。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProject, unapplyProject } from '../src/core/apply.js';
import {
  listTomlMcpSectionNames,
  mergeTomlMcpSections,
  removeTomlMcpSections,
  toTomlMcpSection,
} from '../src/core/apply-mcp.js';
import { listMcps, McpError, removeMcp, upsertMcp } from '../src/core/mcps.js';
import { projectsFile } from '../src/core/paths.js';
import { createProject, getProject, setProjectMcps } from '../src/core/projects.js';
import { listSnapshots, rollback } from '../src/core/snapshot.js';

let tmp: string;
let projectPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
  projectPath = path.join(tmp, 'my-project');
  await fs.mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

describe('mcps 注册表', () => {
  it('upsert stdio / http / sse,字段按 transport 裁剪', async () => {
    const a = await upsertMcp({ name: 'fs', command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' }, url: 'https://x' });
    expect(a.transport).toBe('stdio');
    expect(a.url).toBeUndefined(); // stdio 不保留 url
    const b = await upsertMcp({ name: 'remote', url: 'https://mcp.example.com/mcp' });
    expect(b.transport).toBe('http'); // 有 url 缺省按 http
    const c = await upsertMcp({ name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse', command: 'npx' });
    expect(c.command).toBeUndefined(); // 远端不保留 command
    expect((await listMcps()).map((m) => m.name)).toEqual(['fs', 'remote', 'legacy']);
  });

  it('非法名 / 缺必填字段报错', async () => {
    await expect(upsertMcp({ name: 'has space', command: 'x' })).rejects.toThrow(McpError);
    await expect(upsertMcp({ name: 'a'.repeat(65), command: 'x' })).rejects.toThrow(McpError);
    await expect(upsertMcp({ name: 'nocmd', transport: 'stdio' })).rejects.toThrow('command');
    await expect(upsertMcp({ name: 'nourl', transport: 'http' })).rejects.toThrow('url');
  });

  it('同名 upsert 覆盖且保留 addedAt', async () => {
    const first = await upsertMcp({ name: 'fs', command: 'npx' });
    const second = await upsertMcp({ name: 'fs', command: 'bunx' });
    expect(second.addedAt).toBe(first.addedAt);
    expect((await listMcps()).filter((m) => m.name === 'fs')).toHaveLength(1);
    expect((await listMcps())[0].command).toBe('bunx');
  });

  it('removeMcp 同时解除项目绑定;旧档案缺 mcps 字段兜底为空', async () => {
    await upsertMcp({ name: 'fs', command: 'npx' });
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['fs']);
    expect((await getProject(p.id))?.mcps).toEqual(['fs']);
    await removeMcp('fs');
    expect((await getProject(p.id))?.mcps).toEqual([]);
    expect(await removeMcp('fs')).toBe(false);

    // 模拟旧版 projects.json(无 mcps 字段):读取时归一化为 []
    const raw = JSON.parse(await fs.readFile(projectsFile(), 'utf8'));
    delete raw.projects[0].mcps;
    await fs.writeFile(projectsFile(), JSON.stringify(raw), 'utf8');
    expect((await getProject(p.id))?.mcps).toEqual([]);
  });
});

describe('apply MCP(JSON 系 agent)', () => {
  it('apply 写入各 agent 的项目级配置,远端条目按 agent 习惯序列化', async () => {
    await upsertMcp({ name: 'fs', command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } });
    await upsertMcp({ name: 'remote', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
    await upsertMcp({ name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' });
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code', 'kimi-code', 'cursor'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['fs', 'remote', 'legacy']);

    const result = await applyProject(p.id);
    expect(result.mcpApplied).toHaveLength(9); // 3 agents × 3 servers

    const claude = await readJson(path.join(projectPath, '.mcp.json'));
    expect(claude.mcpServers.fs).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } });
    expect(claude.mcpServers.remote).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
    expect(claude.mcpServers.legacy.type).toBe('sse');

    const kimi = await readJson(path.join(projectPath, '.kimi-code', 'mcp.json'));
    expect(kimi.mcpServers.remote).toEqual({ url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
    expect(kimi.mcpServers.legacy).toEqual({ transport: 'sse', url: 'https://mcp.example.com/sse' });

    const cursor = await readJson(path.join(projectPath, '.cursor', 'mcp.json'));
    expect(cursor.mcpServers.remote).toEqual({ url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
    expect(cursor.mcpServers.legacy.url).toBe('https://mcp.example.com/sse');
  });

  it('合并而非整写:保留用户自己的 server;同名被覆盖', async () => {
    await upsertMcp({ name: 'ours', command: 'npx' });
    const file = path.join(projectPath, '.mcp.json');
    await fs.writeFile(file, JSON.stringify({
      mcpServers: { theirs: { command: 'python', args: ['srv.py'] }, ours: { command: 'outdated' } },
      otherKey: 1,
    }), 'utf8');
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['ours']);
    await applyProject(p.id);

    const merged = await readJson(file);
    expect(merged.mcpServers.theirs).toEqual({ command: 'python', args: ['srv.py'] }); // 用户的保留
    expect(merged.mcpServers.ours).toEqual({ command: 'npx' }); // 同名覆盖
    expect(merged.otherKey).toBe(1);
  });

  it('已有文件先进快照,rollback 还原;新文件 rollback 后删除', async () => {
    await upsertMcp({ name: 'ours', command: 'npx' });
    const claudeFile = path.join(projectPath, '.mcp.json');
    const original = JSON.stringify({ mcpServers: { theirs: { command: 'python' } } });
    await fs.writeFile(claudeFile, original, 'utf8');
    // kimi 无既有文件 → recordCreated 路径
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code', 'kimi-code'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['ours']);
    await applyProject(p.id);
    expect((await listSnapshots(p.id))).toHaveLength(1);

    const rb = await rollback(p.id);
    expect(rb.restored).toBe(true);
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(original); // 原内容还原
    await expect(fs.lstat(path.join(projectPath, '.kimi-code', 'mcp.json'))).rejects.toThrow(); // 新建的被删
  });

  it('幂等:重复 apply 无物化、不新增快照', async () => {
    await upsertMcp({ name: 'fs', command: 'npx' });
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['fs']);
    await applyProject(p.id);
    const second = await applyProject(p.id);
    expect(second.mcpApplied).toHaveLength(0);
    expect(await listSnapshots(p.id)).toHaveLength(1);
  });

  it('绑定里有库中不存在的 server:警告并跳过,不中断其余', async () => {
    await upsertMcp({ name: 'real', command: 'npx' });
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['real', 'ghost']);
    const result = await applyProject(p.id);
    expect(result.mcpApplied).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('ghost'))).toBe(true);
  });

  it('unapply 只摘我们的条目;摘空后删除文件', async () => {
    await upsertMcp({ name: 'ours', command: 'npx' });
    await upsertMcp({ name: 'ours2', url: 'https://x/mcp' });
    const file = path.join(projectPath, '.mcp.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { theirs: { command: 'python' } } }), 'utf8');
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['claude-code'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['ours', 'ours2']);
    await applyProject(p.id);

    const r = await unapplyProject(p.id);
    expect(r.removed).toContain('claude-code:ours');
    expect(r.removed).toContain('claude-code:ours2');
    const after = await readJson(file);
    expect(after.mcpServers).toEqual({ theirs: { command: 'python' } }); // 用户的保留

    // 只有我们的条目时,unapply 直接删文件
    const p2 = await createProject({ name: 'demo2', path: projectPath, agents: ['kimi-code'], applyMode: 'symlink' });
    await setProjectMcps(p2.id, ['ours']);
    await applyProject(p2.id);
    await unapplyProject(p2.id);
    await expect(fs.lstat(path.join(projectPath, '.kimi-code', 'mcp.json'))).rejects.toThrow();
  });
});

describe('apply MCP(codex TOML)', () => {
  it('新文件生成 [mcp_servers.*] 段;已有内容保留', async () => {
    await upsertMcp({ name: 'fs', command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } });
    await upsertMcp({ name: 'remote', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
    const cfgDir = path.join(projectPath, '.codex');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(cfgDir, 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.theirs]\ncommand = "python"\n', 'utf8');

    const p = await createProject({ name: 'demo', path: projectPath, agents: ['codex'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['fs', 'remote']);
    const result = await applyProject(p.id);
    expect(result.mcpApplied).toHaveLength(2);

    const text = await fs.readFile(path.join(cfgDir, 'config.toml'), 'utf8');
    expect(text).toContain('model = "gpt-5"'); // 其它配置保留
    expect(text).toContain('[mcp_servers.theirs]'); // 用户的 server 保留
    expect(text).toContain('[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "pkg"]\nenv = { K = "V" }');
    expect(text).toContain('[mcp_servers.remote]\nurl = "https://mcp.example.com/mcp"\nhttp_headers = { A = "b" }');

    // 幂等:再 apply 一次文本不变、无新快照
    const second = await applyProject(p.id);
    expect(second.mcpApplied).toHaveLength(0);
    expect(await fs.readFile(path.join(cfgDir, 'config.toml'), 'utf8')).toBe(text);
    expect(await listSnapshots(p.id)).toHaveLength(1);
  });

  it('unapply 摘掉我们的段;只剩我们的段时删除文件', async () => {
    await upsertMcp({ name: 'fs', command: 'npx' });
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['codex'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['fs']);
    await applyProject(p.id);
    const file = path.join(projectPath, '.codex', 'config.toml');
    expect((await fs.readFile(file, 'utf8'))).toContain('[mcp_servers.fs]');

    const r = await unapplyProject(p.id);
    expect(r.removed).toContain('codex:fs');
    await expect(fs.lstat(file)).rejects.toThrow(); // 只剩我们的段 → 删文件
  });

  it('unapply 保留其它配置与用户 server 段', async () => {
    await upsertMcp({ name: 'ours', command: 'npx' });
    const p = await createProject({ name: 'demo', path: projectPath, agents: ['codex'], applyMode: 'symlink' });
    await setProjectMcps(p.id, ['ours']);
    await applyProject(p.id);
    // 用户手改了文件:加了自己的 server 段(顶层键应放文件顶部,append 的键按 TOML 语义归属前一段,故用段来测)
    const file = path.join(projectPath, '.codex', 'config.toml');
    await fs.appendFile(file, '\n[mcp_servers.theirs]\ncommand = "python"\n', 'utf8');

    await unapplyProject(p.id);
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('[mcp_servers.ours]');
    expect(text).toContain('[mcp_servers.theirs]');
  });
});

describe('TOML 段工具', () => {
  it('toTomlMcpSection 转义引号与反斜杠', () => {
    const s = toTomlMcpSection('fs', { command: 'my"cmd', args: ['C:\\path', 'b'] });
    expect(s).toBe('[mcp_servers.fs]\ncommand = "my\\"cmd"\nargs = ["C:\\\\path", "b"]');
  });

  it('removeTomlMcpSections 支持引号段名与子表,只摘指定名字', () => {
    const text = [
      '[mcp_servers.quoted-name]',
      'command = "x"',
      '',
      "[mcp_servers.'single']",
      'command = "y"',
      '',
      '[mcp_servers.withsub]',
      'command = "z"',
      '',
      '[mcp_servers.withsub.env]',
      'K = "V"',
      '',
      '[mcp_servers.keep]',
      'command = "w"',
      '',
    ].join('\n');
    const out = removeTomlMcpSections(text, new Set(['quoted-name', 'single', 'withsub']));
    expect(out).not.toContain('quoted-name');
    expect(out).not.toContain('single');
    expect(out).not.toContain('withsub');
    expect(out).toContain('[mcp_servers.keep]');
  });

  it('listTomlMcpSectionNames 收集段名', () => {
    const text = '[mcp_servers.a]\ncommand = "x"\n[mcp_servers."b-c"]\ncommand = "y"\n[other]\nz = 1\n';
    expect([...listTomlMcpSectionNames(text)].sort()).toEqual(['a', 'b-c']);
  });

  it('mergeTomlMcpSections 覆盖同名段且幂等', () => {
    const existing = '[mcp_servers.a]\ncommand = "old"\n';
    const merged = mergeTomlMcpSections(existing, [{ name: 'a', cfg: { command: 'new' } }]);
    expect(merged).toBe('[mcp_servers.a]\ncommand = "new"\n');
    expect(mergeTomlMcpSections(merged, [{ name: 'a', cfg: { command: 'new' } }])).toBe(merged);
  });
});
