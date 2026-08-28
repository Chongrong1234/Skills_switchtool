/**
 * CLI 端到端测试:用 child_process 跑编译产物 dist/cli.js,
 * SSW_HOME 指向 mkdtemp 临时目录,走完整流程并断言文件系统。
 * 依赖 dist/ 存在(beforeAll 里先跑 tsc 编译)。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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
  try {
    const { stdout, stderr } = await execFileP('node', [CLI, ...args], {
      env: { ...process.env, SSW_HOME: sswHome },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeAll(async () => {
  // 确保 dist/cli.js 是最新的(不依赖外部先跑 build)
  await execFileP('npm', ['run', 'build'], { cwd: path.resolve(__dirname, '..') });
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
    expect(r.stderr).toContain('/tmp/a');
    expect(r.stderr).toContain('/tmp/b');
  });

  it('缺必填参数时报错且退出码非零', async () => {
    const r = await cli('project', 'create', '--name', 'only-name');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--path');
  });

  it('agents 子命令列出适配器(--json)', async () => {
    const r = await cli('agents', '--json');
    expect(r.code).toBe(0);
    const agents = JSON.parse(r.stdout);
    expect(agents.map((a: { id: string }) => a.id)).toEqual(['claude-code', 'kimi-code', 'cursor', 'codex']);
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
});
