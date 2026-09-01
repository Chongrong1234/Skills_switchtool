/**
 * CLI 端到端测试:用 child_process 跑编译产物 dist/cli.js,
 * SSW_HOME 指向 mkdtemp 临时目录,走完整流程并断言文件系统。
 * 依赖 dist/ 存在(beforeAll 里先跑 tsc 编译)。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

let sswHome: string;
let projectDir: string;

/** 跑 CLI;出错也正常返回(exit code 断言用) */
async function cli(...args: string[]): Promise<RunResult> {
  return cliIn(undefined, ...args);
}

/** 同 cli,但可指定子进程工作目录(测 --path 缺省取 cwd 用) */
async function cliIn(cwd: string | undefined, ...args: string[]): Promise<RunResult> {
  return cliFull(cwd, {}, ...args);
}

/** 同 cli,但可附加环境变量(测用户级目录用 HOME/USERPROFILE 指到临时目录,绝不碰真实 home) */
async function cliWithEnv(env: NodeJS.ProcessEnv, ...args: string[]): Promise<RunResult> {
  return cliFull(undefined, env, ...args);
}

async function cliFull(cwd: string | undefined, env: NodeJS.ProcessEnv, ...args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP('node', [CLI, ...args], {
      env: { ...process.env, SSW_HOME: sswHome, ...env },
      cwd,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeAll(async () => {
  // 确保 dist/cli.js 是最新的(不依赖外部先跑 build)
  // Windows 上 npm 是 npm.cmd;Node ≥18.20/20.12 起无 shell 直接 spawn .cmd 会抛 EINVAL,
  // 仅把名字换成 npm.cmd 并不能绕过——必须 shell:true 让 cmd.exe 来执行
  await execFileP(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: path.resolve(__dirname, '..'),
    shell: process.platform === 'win32',
  });
}, 120000);

beforeEach(async () => {
  sswHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-cli-test-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-cli-proj-'));
});

afterEach(async () => {
  await fs.rm(sswHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('ssw CLI', () => {
  it('完整流程:init → create → bind → apply → list → switch → rollback → remove', async () => {
    // skill init(--json 断言字段)
    const init = await cli('skill', 'init', '--name', 'e2e-cli', '--desc', '端到端测试技能', '--json');
    expect(init.code).toBe(0);
    const skill = JSON.parse(init.stdout);
    expect(skill.id).toBe('local:e2e-cli');
    expect(skill.name).toBe('e2e-cli');

    // project create(--json 拿 id)
    const create = await cli(
      'project', 'create', '--name', 'cliproj', '--path', projectDir,
      '--agents', 'claude-code,kimi-code', '--mode', 'symlink', '--json',
    );
    expect(create.code).toBe(0);
    const project = JSON.parse(create.stdout);
    expect(project.name).toBe('cliproj');
    expect(project.skills).toEqual([]);

    // bind
    const bind = await cli('project', 'bind', 'cliproj', 'local:e2e-cli');
    expect(bind.code).toBe(0);

    // apply(断言 symlink 存在且指向库)
    const apply = await cli('project', 'apply', 'cliproj', '--json');
    expect(apply.code).toBe(0);
    const applyResult = JSON.parse(apply.stdout);
    expect(applyResult.applied).toHaveLength(2);
    for (const dir of ['.claude', '.kimi-code']) {
      const link = path.join(projectDir, dir, 'skills', 'e2e-cli');
      const st = await fs.lstat(link);
      expect(st.isSymbolicLink()).toBe(true);
      expect(await fs.realpath(link)).toBe(await fs.realpath(path.join(sswHome, 'library', 'local__e2e-cli')));
    }

    // project list 含激活标记(先 switch 激活)
    const sw = await cli('project', 'switch', 'cliproj');
    expect(sw.code).toBe(0);
    expect(sw.stdout).toContain('已切换');
    const list = await cli('project', 'list');
    expect(list.stdout).toMatch(/^\* /m);
    expect(list.stdout).toContain('cliproj');
    // --json 形式
    const listJson = JSON.parse((await cli('project', 'list', '--json')).stdout);
    expect(listJson.activeProjectId).toBe(project.id);

    // rollback
    const rb = await cli('project', 'rollback', 'cliproj');
    expect(rb.code).toBe(0);
    expect(rb.stdout).toContain('已回滚');

    // remove
    const rm = await cli('project', 'remove', 'cliproj');
    expect(rm.code).toBe(0);
    const listAfter = JSON.parse((await cli('project', 'list', '--json')).stdout);
    expect(listAfter.projects).toHaveLength(0);
  });

  it('skill init 支持粘贴内容:--file 读入完整 SKILL.md(frontmatter 兜底 name/desc),--content 与 --file 互斥', async () => {
    // --file:从文件读入,name/desc 由 frontmatter 兜底
    const src = path.join(projectDir, 'pasted.md');
    await fs.writeFile(src, '---\nname: file-skill\ndescription: 文件导入\n---\n\n# 正文\n做 Z。\n', 'utf8');
    const init = await cli('skill', 'init', '--file', src, '--json');
    expect(init.code).toBe(0);
    const skill = JSON.parse(init.stdout);
    expect(skill.id).toBe('local:file-skill');
    expect(skill.description).toBe('文件导入');
    const written = await fs.readFile(path.join(sswHome, 'library', 'local__file-skill', 'SKILL.md'), 'utf8');
    expect(written).toContain('# 正文');
    expect(written.match(/^---$/gm)?.length).toBe(2); // 只有重新生成的一份 frontmatter

    // --content 直接给文本(纯正文,需显式 name/desc)
    const init2 = await cli('skill', 'init', '--name', 'inline-skill', '--desc', '内联内容', '--content', '## 只做这一件事', '--json');
    expect(init2.code).toBe(0);
    const written2 = await fs.readFile(path.join(sswHome, 'library', 'local__inline-skill', 'SKILL.md'), 'utf8');
    expect(written2).toContain('## 只做这一件事');

    // --content 与 --file 互斥 → 非零退出;缺 name/desc 且无内容 → 非零退出
    expect((await cli('skill', 'init', '--name', 'x', '--desc', 'y', '--content', 'a', '--file', src)).code).not.toBe(0);
    expect((await cli('skill', 'init', '--name', 'only-name')).code).not.toBe(0);
  });

  it('apply 省略参数时使用当前激活项目', async () => {
    await cli('skill', 'init', '--name', 's1', '--desc', 'd1');
    await cli('project', 'create', '--name', 'p1', '--path', projectDir, '--agents', 'claude-code');
    await cli('project', 'bind', 'p1', 'local:s1');
    await cli('project', 'switch', 'p1');
    const apply = await cli('project', 'apply'); // 省略 id|name
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain('p1');
  });

  it('id|name 寻址:id 精确匹配优先;找不到时退出码非零且错误走 stderr', async () => {
    const create = await cli('project', 'create', '--name', 'p1', '--path', projectDir, '--agents', 'claude-code', '--json');
    const project = JSON.parse(create.stdout);
    // 用完整 id 寻址
    const show = await cli('project', 'show', project.id, '--json');
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout).name).toBe('p1');
    // 找不到
    const ghost = await cli('project', 'show', 'no-such-project');
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('找不到项目');
    expect(ghost.stdout).toBe('');
  });

  it('name 歧义时报错并列出候选', async () => {
    await cli('project', 'create', '--name', 'dup', '--path', '/tmp/a', '--agents', 'claude-code');
    await cli('project', 'create', '--name', 'dup', '--path', '/tmp/b', '--agents', 'claude-code');
    const r = await cli('project', 'show', 'dup');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('匹配到多个项目');
    // CLI 存的是 path.resolve 后的绝对路径;Windows 上 /tmp/a 会解析到当前盘符(形如 D:\tmp\a)
    expect(r.stderr).toContain(path.resolve('/tmp/a'));
    expect(r.stderr).toContain(path.resolve('/tmp/b'));
  });

  it('缺必填参数时报错且退出码非零', async () => {
    const r = await cli('project', 'create', '--path', '/tmp/x');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--name');
  });

  it('project create 省略 --path 时取当前工作目录', async () => {
    const r = await cliIn(projectDir, 'project', 'create', '--name', 'cwdproj', '--agents', 'claude-code', '--json');
    expect(r.code).toBe(0);
    // 两侧都过 realpath:Windows runner 上 TEMP 带 8.3 短名(RUNNER~1),cwd 原样保留短名,realpath 展开成长名
    expect(await fs.realpath(JSON.parse(r.stdout).path)).toBe(await fs.realpath(projectDir));
  });

  it('agents 子命令列出适配器(--json)', async () => {
    const r = await cli('agents', '--json');
    expect(r.code).toBe(0);
    const agents = JSON.parse(r.stdout);
    expect(agents.map((a: { id: string }) => a.id)).toEqual([
      'claude-code', 'kimi-code', 'cursor', 'codex', 'qwen-code', 'trae', 'factory-droid',
      'agents', 'gemini-cli', 'copilot', 'windsurf', 'opencode', 'roo-code',
      'openclaw', 'deepseek-harness', 'cline', 'continue', 'crush', 'amp',
    ]);
    expect(typeof agents[0].detected).toBe('boolean');
  });

  it('skill list / remove', async () => {
    await cli('skill', 'init', '--name', 'rm-me', '--desc', 'x');
    const list = JSON.parse((await cli('skill', 'list', '--json')).stdout);
    expect(list.some((s: { id: string }) => s.id === 'local:rm-me')).toBe(true);
    const rm = await cli('skill', 'remove', 'local:rm-me');
    expect(rm.code).toBe(0);
    const list2 = JSON.parse((await cli('skill', 'list', '--json')).stdout);
    expect(list2.some((s: { id: string }) => s.id === 'local:rm-me')).toBe(false);
    // 再删一次:退出码非零
    const rm2 = await cli('skill', 'remove', 'local:rm-me');
    expect(rm2.code).not.toBe(0);
  });

  it('bind 不存在的 skill 报错', async () => {
    await cli('project', 'create', '--name', 'p1', '--path', projectDir, '--agents', 'claude-code');
    const r = await cli('project', 'bind', 'p1', 'local:ghost');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('库中不存在');
  });

  it('skill add 两个来源互斥校验', async () => {
    const r = await cli('skill', 'add', '--github', 'a/b', '--local', '/tmp/x');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--github 或 --local 之一');
  });

  it('裸跑(非 TTY)打印帮助并退出 0,不挂起(TTY 下才进交互面板)', async () => {
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: ssw');
  });

  it('--version 输出版本号,且与 package.json 一致(版本号单一来源)', async () => {
    const r = await cli('--version');
    expect(r.code).toBe(0);
    const pkg = JSON.parse(await fs.readFile(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('mcp add → bind-mcp → apply 写入 .mcp.json → unapply 摘除 → remove', async () => {
    // add(stdio + 逗号 args/env)
    const add = await cli('mcp', 'add', '--name', 'fs', '--command', 'npx',
      '--args', '-y,@mcp/server', '--env', 'TOKEN=abc', '--desc', '文件系统', '--json');
    expect(add.code).toBe(0);
    const entry = JSON.parse(add.stdout);
    expect(entry.transport).toBe('stdio');
    expect(entry.args).toEqual(['-y', '@mcp/server']);
    expect(entry.env).toEqual({ TOKEN: 'abc' });

    // add(远端,缺省 http)
    const addRemote = await cli('mcp', 'add', '--name', 'remote', '--url', 'https://mcp.example.com/mcp');
    expect(addRemote.code).toBe(0);

    // list
    const list = JSON.parse((await cli('mcp', 'list', '--json')).stdout);
    expect(list.map((m: { name: string }) => m.name)).toEqual(['fs', 'remote']);

    // 缺 --command/--url 报错
    const badAdd = await cli('mcp', 'add', '--name', 'bad');
    expect(badAdd.code).not.toBe(0);

    // create + bind-mcp
    await cli('project', 'create', '--name', 'mcpproj', '--path', projectDir, '--agents', 'claude-code,codex');
    const bind = await cli('project', 'bind-mcp', 'mcpproj', 'fs', 'remote');
    expect(bind.code).toBe(0);
    // 绑定不存在的 server 报错
    const badBind = await cli('project', 'bind-mcp', 'mcpproj', 'ghost');
    expect(badBind.code).not.toBe(0);
    expect(badBind.stderr).toContain('MCP server');

    // show 里能看到 MCP 服务集
    const show = await cli('project', 'show', 'mcpproj');
    expect(show.stdout).toContain('MCP 服务集(2)');

    // apply:claude 写 .mcp.json,codex 写 .codex/config.toml
    const apply = await cli('project', 'apply', 'mcpproj', '--json');
    expect(apply.code).toBe(0);
    expect(JSON.parse(apply.stdout).mcpApplied).toHaveLength(4); // 2 agents × 2 servers
    const mcpJson = JSON.parse(await fs.readFile(path.join(projectDir, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers.fs).toEqual({ command: 'npx', args: ['-y', '@mcp/server'], env: { TOKEN: 'abc' } });
    expect(mcpJson.mcpServers.remote).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp' });
    const toml = await fs.readFile(path.join(projectDir, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.fs]');
    expect(toml).toContain('[mcp_servers.remote]');

    // unapply:配置文件被删除(只有我们的条目)
    const unapply = await cli('project', 'unapply', 'mcpproj');
    expect(unapply.code).toBe(0);
    await expect(fs.lstat(path.join(projectDir, '.mcp.json'))).rejects.toThrow();
    await expect(fs.lstat(path.join(projectDir, '.codex', 'config.toml'))).rejects.toThrow();

    // remove
    const rm = await cli('mcp', 'remove', 'fs');
    expect(rm.code).toBe(0);
    const listAfter = JSON.parse((await cli('mcp', 'list', '--json')).stdout);
    expect(listAfter.map((m: { name: string }) => m.name)).toEqual(['remote']);
  });

  it('global / profile / adopt 全流程(用户级目录用临时 HOME 隔离)', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-cli-home-'));
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    try {
      await cli('skill', 'init', '--name', 'g-cli', '--desc', '全局共享');

      // global:agents → bind → apply → show → unapply → apply → rollback
      expect((await cli('global', 'agents', 'claude-code')).code).toBe(0);
      expect((await cli('global', 'bind', 'local:g-cli')).code).toBe(0);
      expect((await cli('global', 'bind', 'local:ghost')).code).not.toBe(0); // 不存在的 skill 报错
      const apply = await cliWithEnv(env, 'global', 'apply', '--json');
      expect(apply.code).toBe(0);
      expect(JSON.parse(apply.stdout).applied).toHaveLength(1);
      const link = path.join(fakeHome, '.claude', 'skills', 'g-cli');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);

      const show = JSON.parse((await cli('global', 'show', '--json')).stdout);
      expect(show.skills).toEqual(['local:g-cli']);
      expect(show.agents).toEqual(['claude-code']);

      const unapply = await cliWithEnv(env, 'global', 'unapply', '--json');
      expect(JSON.parse(unapply.stdout).removed).toHaveLength(1);
      await cliWithEnv(env, 'global', 'apply');
      const rb = await cliWithEnv(env, 'global', 'rollback');
      expect(rb.code).toBe(0);
      await expect(fs.lstat(link)).rejects.toThrow();

      // profile:导出到文件 → 全新 SSW_HOME 导入(local 技能文件内嵌还原 + 全局档案跟随)
      const pf = path.join(projectDir, 'p.json');
      expect((await cli('profile', 'export', '--file', pf)).code).toBe(0);
      const bundle = JSON.parse(await fs.readFile(pf, 'utf8'));
      expect(bundle.format).toBe('ssw-profile@1');
      expect(bundle.skills.some((s: { id: string }) => s.id === 'local:g-cli')).toBe(true);
      expect(Object.keys(bundle.localFiles)).toContain('local:g-cli');

      const home2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-cli-home2-'));
      try {
        const imp = await cliWithEnv({ ...env, SSW_HOME: home2 }, 'profile', 'import', pf, '--json');
        expect(imp.code).toBe(0);
        const impR = JSON.parse(imp.stdout);
        expect(impR.localRestored).toEqual(['local:g-cli']);
        expect(impR.globalImported).toBe(true);
        expect(await fs.readFile(path.join(home2, 'library', 'local__g-cli', 'SKILL.md'), 'utf8')).toContain('g-cli');
        const g2 = JSON.parse((await cliWithEnv({ SSW_HOME: home2 }, 'global', 'show', '--json')).stdout);
        expect(g2.skills).toEqual(['local:g-cli']);
      } finally {
        await fs.rm(home2, { recursive: true, force: true });
      }

      // adopt:用户在 ~/.claude/skills 自攒的 skill 收养进中央库
      const ownDir = path.join(fakeHome, '.claude', 'skills', 'own-skill');
      await fs.mkdir(ownDir, { recursive: true });
      await fs.writeFile(path.join(ownDir, 'SKILL.md'), '---\nname: own-skill\ndescription: 自攒\n---\n', 'utf8');
      const adopt = await cliWithEnv(env, 'skill', 'adopt', '--agent', 'claude-code', '--user', '--json');
      expect(adopt.code).toBe(0);
      expect(JSON.parse(adopt.stdout).adopted.map((s: { id: string }) => s.id)).toEqual(['local:own-skill']);
      // 幂等:再收养一次全部跳过
      const again = JSON.parse((await cliWithEnv(env, 'skill', 'adopt', '--agent', 'claude-code', '--user', '--json')).stdout);
      expect(again.adopted).toEqual([]);
      expect(again.skipped).toContain('own-skill');

      // adopt --all:一次扫描所有 agent(用户级);新 agent 目录里的收养,已在库的跳过
      const kimiDir = path.join(fakeHome, '.kimi-code', 'skills', 'kimi-only');
      await fs.mkdir(kimiDir, { recursive: true });
      await fs.writeFile(path.join(kimiDir, 'SKILL.md'), '---\nname: kimi-only\ndescription: 自攒2\n---\n', 'utf8');
      const all = JSON.parse((await cliWithEnv(env, 'skill', 'adopt', '--all', '--user', '--json')).stdout);
      expect(all.adopted.map((s: { id: string }) => s.id)).toEqual(['local:kimi-only']);
      expect(all.skipped).toContain('own-skill');
      expect(all.scanned.length).toBeGreaterThan(0);
      expect(all.skippedAgents.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('catalog categories:分类统计;catalog --category 按分类过滤', async () => {
    // --json:分类表带 count/skills/mcps 细分,总数一致
    const r = await cli('catalog', 'categories', '--json');
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.categories.length).toBeGreaterThan(0);
    for (const c of data.categories) expect(c.count).toBe(c.skills + c.mcps);
    expect(data.categories.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(data.total);

    // 纯文本输出含分类 id 与名称;--category 过滤只含该分类
    const plain = await cli('catalog', 'categories');
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('dev');
    const dev = data.categories[0];
    const filtered = await cli('catalog', '--category', dev.id, '--json');
    expect(filtered.code).toBe(0);
    const items = JSON.parse(filtered.stdout).items;
    expect(items.length).toBe(dev.count);
    expect(items.every((e: { category: string }) => e.category === dev.id)).toBe(true);
  });

  it('catalog --kind:skills 与 MCP 分流;非法值报错', async () => {
    const skills = await cli('catalog', '--kind', 'skill', '--json');
    expect(skills.code).toBe(0);
    const skillItems = JSON.parse(skills.stdout).items;
    expect(skillItems.length).toBeGreaterThan(0);
    expect(skillItems.every((e: { kind?: string }) => e.kind !== 'mcp')).toBe(true);

    const mcps = await cli('catalog', '--kind', 'mcp', '--json');
    expect(mcps.code).toBe(0);
    const mcpItems = JSON.parse(mcps.stdout).items;
    expect(mcpItems.length).toBeGreaterThan(0);
    expect(mcpItems.every((e: { kind?: string }) => e.kind === 'mcp')).toBe(true);

    const bad = await cli('catalog', '--kind', 'nope');
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('--kind');
  });

  it('catalog --github/--ai 必须配合 --q(联网路径由 core/server 注入假 fetch 覆盖,这里只测参数校验)', async () => {
    for (const flag of ['--github', '--ai']) {
      const r = await cli('catalog', flag);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('--q');
    }
    // 不带联网开关时输出末尾给引导;--json 不含 github 字段(向后兼容)
    const plain = await cli('catalog', '--q', 'superpowers');
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('superpowers');
    expect(plain.stdout).toContain('--github');
    const js = await cli('catalog', '--q', 'superpowers', '--json');
    expect(js.code).toBe(0);
    expect(JSON.parse(js.stdout).github).toBeUndefined();
  });

  it('skill 支持 id|name 寻址:bind/remove 可用名称;不存在时报错含引导', async () => {
    await cli('skill', 'init', '--name', 'byname', '--desc', 'x');
    await cli('project', 'create', '--name', 'np', '--path', projectDir, '--agents', 'claude-code');
    // 用名称 bind(库内 id 是 local:byname)
    const bind = await cli('project', 'bind', 'np', 'byname', '--json');
    expect(bind.code).toBe(0);
    expect(JSON.parse(bind.stdout).skills).toEqual(['local:byname']);
    // 用名称 remove
    const rm = await cli('skill', 'remove', 'byname');
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain('local:byname');
    // 不存在 → 报错并引导看 skill list
    const ghost = await cli('project', 'bind', 'np', 'ghost-skill');
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('库中不存在');
  });

  it('project create 免 --agents:缺省取本机检测到的 agent(不含恒真的通用 agents);零检测时报错', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-cli-home-'));
    try {
      await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      const env = { HOME: fakeHome, USERPROFILE: fakeHome };
      const r = await cliWithEnv(env, 'project', 'create', '--name', 'auto', '--path', projectDir, '--json');
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).agents).toEqual(['claude-code']);
      // 一个 agent 都没检测到时必须显式指定(报错给出可用列表)
      const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-cli-empty-'));
      try {
        const bad = await cliWithEnv({ HOME: emptyHome, USERPROFILE: emptyHome }, 'project', 'create', '--name', 'noagent', '--path', projectDir);
        expect(bad.code).not.toBe(0);
        expect(bad.stderr).toContain('未检测到任何 agent');
      } finally {
        await fs.rm(emptyHome, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor:环境自检报告;数据文件损坏时退出码非零', async () => {
    const ok = await cli('doctor', '--json');
    expect(ok.code).toBe(0);
    const report = JSON.parse(ok.stdout);
    expect(report.ok).toBe(true);
    expect(typeof report.version).toBe('string');
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual(['ssw-home', 'git', 'agents', 'registry', 'projects', 'mcps', 'global', 'update']);
    expect(report.stats).toEqual({ skills: 0, mcps: 0, projects: 0, activeProject: null });

    // 损坏 registry.json → error 级,退出码非零,人类输出带 ✗ 与修复建议
    await fs.writeFile(path.join(sswHome, 'registry.json'), '{oops', 'utf8');
    const bad = await cli('doctor');
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toContain('✗');
    expect(bad.stdout).toContain('建议');
  });

  it('update:假 release(SSW_UPDATE_API 注入本地服务)发现新版本;--auto-check 写配置', async () => {
    // 本地 HTTP 服务冒充 GitHub releases API,不打真实外网
    const srv = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/Chongrong1234/Skills_switchtool/releases/tag/v99.0.0',
          published_at: '2026-09-01T00:00:00Z',
          assets: [
            // 资产覆盖三平台:checkForUpdate 按运行平台挑资产,只有 AppImage 时 mac/win 挑不到,
            // CLI 就不打印 --download 引导(CI 三平台都跑)
            {
              name: 'Skills.SwitchTool-99.0.0.AppImage',
              browser_download_url: 'https://fake.test/x.AppImage',
              size: 1024,
            },
            {
              name: 'Skills.SwitchTool-99.0.0.Setup.exe',
              browser_download_url: 'https://fake.test/x.exe',
              size: 1024,
            },
            {
              name: 'Skills.SwitchTool-99.0.0-arm64.dmg',
              browser_download_url: 'https://fake.test/arm64.dmg',
              size: 1024,
            },
            {
              name: 'Skills.SwitchTool-99.0.0.dmg',
              browser_download_url: 'https://fake.test/x64.dmg',
              size: 1024,
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const env = { SSW_UPDATE_API: `http://127.0.0.1:${port}/latest` };
      // 检查:发现新版本,输出引导 --download / --open
      const r = await cliWithEnv(env, 'update');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('发现新版本: v99.0.0');
      expect(r.stdout).toContain('ssw update --download');

      // --json:结构化结果
      const j = await cliWithEnv(env, 'update', '--json');
      expect(j.code).toBe(0);
      const parsed = JSON.parse(j.stdout);
      expect(parsed.hasUpdate).toBe(true);
      expect(parsed.latest).toBe('99.0.0');

      // 配置开关:纯本地读写,落盘 update.json
      const cfg = await cliWithEnv(env, 'update', '--auto-check', 'off');
      expect(cfg.code).toBe(0);
      expect(cfg.stdout).toContain('自动检查 关');
      const saved = JSON.parse(await fs.readFile(path.join(sswHome, 'update.json'), 'utf8'));
      expect(saved).toEqual({ autoCheck: false, autoDownload: false, skillsAutoCheck: true, skillsCheckIntervalHours: 6 });

      // 非法开关值报错、退出码非零
      const badVal = await cliWithEnv(env, 'update', '--auto-check', 'maybe');
      expect(badVal.code).not.toBe(0);
      expect(badVal.stderr).toContain('on 或 off');
    } finally {
      srv.close();
    }
  });

  it('skill update --check:空库提示;本地 git 仓库模拟上游更新后能查出落后(退出码 1)', async () => {
    // 空库:没有 github 来源
    const empty = await cli('skill', 'update', '--check');
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('没有 github 来源');

    // 造本地 git "远程"(bare)+ 工作仓库,克隆进库目录并写注册表条目(全程不触网)
    const git = (args: string[]) => execFileP('git', args);
    const remoteDir = path.join(sswHome, '..', 'remote-cli-upd.git');
    const workDir = path.join(sswHome, '..', 'work-cli-upd');
    await git(['init', '--bare', '-b', 'main', remoteDir]);
    await git(['init', '-b', 'main', workDir]);
    await fs.mkdir(path.join(workDir, 'demo'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\n# demo\n');
    await git(['-C', workDir, 'add', '.']);
    await git(['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
    await git(['-C', workDir, 'remote', 'add', 'origin', remoteDir]);
    await git(['-C', workDir, 'push', '-u', 'origin', 'main']);
    await git(['clone', remoteDir, path.join(sswHome, 'library', 'github__o__cli-upd')]);
    await fs.writeFile(
      path.join(sswHome, 'registry.json'),
      JSON.stringify({
        skills: [
          {
            id: 'o/cli-upd:demo',
            name: 'demo',
            description: 'd',
            source: { type: 'github', uri: 'o/cli-upd' },
            tags: [],
            installedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    // 上游无新提交:已是最新,退出码 0
    const fresh = await cli('skill', 'update', '--check');
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toContain('全部已是最新');

    // 上游推一个新提交:查出落后,退出码 1(脚本可判断"需要更新"),输出引导一键更新
    await fs.writeFile(path.join(workDir, 'demo', 'extra.md'), 'v2');
    await git(['-C', workDir, 'add', '.']);
    await git(['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v2']);
    await git(['-C', workDir, 'push']);
    const behind = await cli('skill', 'update', '--check');
    expect(behind.code).toBe(1);
    expect(behind.stdout).toContain('落后 1 个提交');
    expect(behind.stdout).toContain('ssw skill update');

    // 清理库外的 git fixture(afterEach 只清 sswHome/projectDir)
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    // Windows CI 上 node 起子进程 + 密集 git 调用很慢,默认 20s 偶发不够,放宽到 60s
  }, 60000);

  it('update --skills-check on|off:写 update.json 的技能库定时检查开关', async () => {
    const off = await cli('update', '--skills-check', 'off');
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('定时检查技能库 关');
    const saved = JSON.parse(await fs.readFile(path.join(sswHome, 'update.json'), 'utf8'));
    expect(saved.skillsAutoCheck).toBe(false);
    // 再开回来
    const on = await cli('update', '--skills-check', 'on', '--json');
    expect(JSON.parse(on.stdout).skillsAutoCheck).toBe(true);
  });
});
