/**
 * library 测试:initSkill 脚手架合法、local 安装复制目录、SKILL.md 缺失拒绝安装、卸载、git 超时快速报错。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLibraryUpdates,
  checkLibraryUpdates,
  getLastLibraryUpdates,
  initSkill,
  installFromGithub,
  installFromLocal,
  parseFrontmatter,
  parseProgressSegment,
  registerSkillsWithFallback,
  sameRealPath,
  skillDirOf,
  summarizeStderr,
  uninstall,
  updateSkill,
  validateSkillDir,
} from '../src/core/library.js';
import { libraryDir } from '../src/core/paths.js';
import { createProject, getProject, setProjectSkills } from '../src/core/projects.js';
import { getSkill, readRegistry, upsertSkill } from '../src/core/registry.js';
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

describe('library', () => {
  it('initSkill 生成合法 SKILL.md(frontmatter name/description 非空)', async () => {
    const entry = await initSkill('my-skill', '我的测试技能');
    expect(entry.id).toBe('local:my-skill');
    const dir = skillDirOf(entry);
    const content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(content);
    expect(fm?.name).toBe('my-skill');
    expect(fm?.description).toBe('我的测试技能');
    // 能通过完整校验
    await expect(validateSkillDir(dir)).resolves.toEqual({ name: 'my-skill', description: '我的测试技能' });
    // 已登记进注册表
    expect((await getSkill('local:my-skill'))?.name).toBe('my-skill');
  });

  it('initSkill 拒绝非法名称与空描述', async () => {
    await expect(initSkill('Bad_Name', 'x')).rejects.toThrow('名称');
    await expect(initSkill('ok-name', '')).rejects.toThrow('description');
  });

  it('initSkill 粘贴纯正文:直接作为 SKILL.md 正文,不用模板', async () => {
    const entry = await initSkill('body-skill', '正文测试', '## 自定义内容\n\n按步骤做 X。');
    const content = await fs.readFile(path.join(skillDirOf(entry), 'SKILL.md'), 'utf8');
    expect(content).toContain('name: body-skill');
    expect(content).toContain('## 自定义内容');
    expect(content).not.toContain('使用说明'); // 未用默认模板
    await expect(validateSkillDir(skillDirOf(entry))).resolves.toEqual({ name: 'body-skill', description: '正文测试' });
  });

  it('initSkill 粘贴完整 SKILL.md:剥掉原 frontmatter,name/description 可由其兜底;显式参数优先', async () => {
    const pasted = '---\nname: pasted-skill\ndescription: 粘贴进来的描述\n---\n\n# 正文\n\n做 Y。\n';
    // name/description 缺省时从粘贴内容的 frontmatter 兜底
    const entry = await initSkill('', '', pasted);
    expect(entry.id).toBe('local:pasted-skill');
    const content = await fs.readFile(path.join(skillDirOf(entry), 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(content);
    expect(fm?.name).toBe('pasted-skill');
    expect(fm?.description).toBe('粘贴进来的描述');
    expect(content).toContain('# 正文');
    // 只有重新生成的一份 frontmatter
    expect(content.match(/^---$/gm)?.length).toBe(2);
    // 显式参数覆盖粘贴内容里的 frontmatter
    const entry2 = await initSkill('explicit-name', '显式描述', pasted);
    const c2 = await fs.readFile(path.join(skillDirOf(entry2), 'SKILL.md'), 'utf8');
    expect(c2).toContain('name: explicit-name');
    expect(c2).not.toContain('pasted-skill');
    expect(c2).toContain('# 正文');
  });

  it('local 安装会复制目录入中央库', async () => {
    // 造一个本地 skill 源目录
    const src = path.join(tmp, 'outside', 'cool-skill');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(
      path.join(src, 'SKILL.md'),
      '---\nname: cool-skill\ndescription: 一个很酷的技能\n---\n\n# cool\n',
      'utf8',
    );
    await fs.writeFile(path.join(src, 'helper.txt'), 'extra file', 'utf8');

    const entry = await installFromLocal(src);
    expect(entry.id).toBe('local:cool-skill');
    const dest = skillDirOf(entry);
    // 内容被复制(连同附带文件)
    expect(await fs.readFile(path.join(dest, 'helper.txt'), 'utf8')).toBe('extra file');
    // 是复制而非引用:删掉源目录后库内仍完整
    await fs.rm(src, { recursive: true, force: true });
    expect((await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'))).toContain('cool-skill');
  });

  it('SKILL.md 缺失时拒绝安装', async () => {
    const src = path.join(tmp, 'no-skillmd');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'README.md'), 'nothing', 'utf8');
    await expect(installFromLocal(src)).rejects.toThrow('SKILL.md');
  });

  it('frontmatter 缺少 name/description 时拒绝', async () => {
    const src = path.join(tmp, 'bad-frontmatter');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: ""\n---\nno desc\n', 'utf8');
    await expect(installFromLocal(src)).rejects.toThrow('frontmatter');
  });

  it('uninstall 删除库目录与注册表记录', async () => {
    const entry = await initSkill('gone-skill', '马上被删');
    const r = await uninstall(entry.id);
    expect(r.removed).toBe(true);
    expect(r.alsoRemoved).toEqual([]);
    expect(await getSkill(entry.id)).toBeUndefined();
    await expect(fs.access(skillDirOf(entry))).rejects.toThrow();
    expect((await uninstall(entry.id)).removed).toBe(false);
  });

  it('uninstall 同时解除项目中的绑定', async () => {
    const entry = await initSkill('bound-skill', '被项目绑定');
    const p = await createProject({ name: 'demo', path: '/tmp/demo', agents: [], applyMode: 'symlink' });
    await setProjectSkills(p.id, [entry.id]);
    await uninstall(entry.id);
    expect((await getProject(p.id))?.skills).toEqual([]);
  });

  it('updateSkill 对库内自建的 local skill 只刷新元数据,不做自杀式复制', async () => {
    const entry = await initSkill('self-upd', '旧描述');
    const dir = skillDirOf(entry);
    // 用户直接编辑库内的 SKILL.md
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: self-upd\ndescription: 新描述\n---\n',
      'utf8',
    );
    const next = await updateSkill(entry.id);
    expect(next.description).toBe('新描述');
    expect(next.tags).toEqual(['custom']); // 原有 tags 不丢
    // 目录内容仍在(没被 rm 掉)
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('新描述');
  });

  it('installFromLocal 拒绝源目录已在库内(防止 rm 后自我复制)', async () => {
    const entry = await initSkill('in-lib', '库内');
    await expect(installFromLocal(skillDirOf(entry))).rejects.toThrow('已在库中');
  });

  /** 手工造一个 github 仓库条目(不走 git clone) */
  async function seedGithubSkill(id: string, uri: string): Promise<SkillEntry> {
    const entry: SkillEntry = {
      id,
      name: id.split(':').pop() || 'root',
      description: 'd',
      source: { type: 'github', uri },
      tags: [],
      installedAt: new Date().toISOString(),
    };
    await fs.mkdir(skillDirOf(entry), { recursive: true });
    await upsertSkill(entry);
    return entry;
  }

  it('uninstall 根级 github skill 时连带清理同仓库条目与整仓目录', async () => {
    await seedGithubSkill('o/r:', 'o/r');
    await seedGithubSkill('o/r:sub', 'o/r');
    const repoDir = path.join(libraryDir(), 'github__o__r');
    const r = await uninstall('o/r:');
    expect(r.removed).toBe(true);
    expect(r.alsoRemoved).toEqual(['o/r:sub']);
    expect(await readRegistry()).toEqual([]);
    await expect(fs.access(repoDir)).rejects.toThrow();
  });

  it('uninstall 最后一个子路径 github skill 时删除整个仓库目录', async () => {
    await seedGithubSkill('o/r2:sub', 'o/r2');
    const repoDir = path.join(libraryDir(), 'github__o__r2');
    const r = await uninstall('o/r2:sub');
    expect(r.removed).toBe(true);
    expect(r.alsoRemoved).toEqual([]);
    await expect(fs.access(repoDir)).rejects.toThrow();
  });

  it('uninstall 子路径 skill 且仓库还有其他条目时保留仓库目录', async () => {
    const a = await seedGithubSkill('o/r3:a', 'o/r3');
    await seedGithubSkill('o/r3:b', 'o/r3');
    const repoDir = path.join(libraryDir(), 'github__o__r3');
    const r = await uninstall('o/r3:a');
    expect(r.alsoRemoved).toEqual([]);
    await expect(fs.access(repoDir)).resolves.toBeUndefined();
    expect(await getSkill('o/r3:b')).toBeDefined();
    await expect(fs.access(skillDirOf(a))).rejects.toThrow();
  });

  it('subdir 拒绝反斜杠/冒号/越界段(在 git clone 前校验,不触网)', async () => {
    // '\':Windows 路径分隔符,'..\..' 会穿越到库外;':':撑爆 id 的 split(':')
    for (const bad of ['..\\..', 'a:b', 'skills\\evil', '..', 'a//b', '']) {
      await expect(installFromGithub('owner/repo', bad)).rejects.toThrow('非法子目录');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'git 挂起时按超时快速报错,不永久"安装中"(SSW_GIT_TIMEOUT_MS 可覆盖)',
    async () => {
      // 造一个只会沉睡的假 git 放在 PATH 最前;clone 永不返回 → 应被 timeout 杀掉并报超时。
      // win32 跳过:.cmd 无法被 execFile 直接 spawn(Node ≥18.20/20.12 起无 shell 抛 EINVAL)
      const binDir = path.join(tmp, 'fake-bin');
      await fs.mkdir(binDir, { recursive: true });
      const sleeper = path.join(binDir, 'git-sleeper.mjs');
      await fs.writeFile(sleeper, 'setTimeout(() => {}, 60_000);\n', 'utf8');
      const fakeGit = path.join(binDir, 'git');
      // exec 让 node 顶替 sh 进程,timeout 杀死的就是它,不留孤儿
      await fs.writeFile(fakeGit, `#!/bin/sh\nexec "${process.execPath}" "${sleeper}" "$@"\n`, 'utf8');
      await fs.chmod(fakeGit, 0o755);
      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
      process.env.SSW_GIT_TIMEOUT_MS = '150';
      try {
        await expect(installFromGithub('owner/repo')).rejects.toThrow(/超时/);
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        delete process.env.SSW_GIT_TIMEOUT_MS;
      }
      // 失败不留半个 clone 的残目录
      await expect(fs.access(path.join(libraryDir(), 'github__owner__repo'))).rejects.toThrow();
    },
  );

  it('sameRealPath 识别同一位置的不同写法(防自杀式复制绕过)', async () => {
    const dir = path.join(tmp, 'real-dir');
    await fs.mkdir(dir, { recursive: true });
    // "dir/../dir" 等价写法
    expect(await sameRealPath(dir, path.join(tmp, 'real-dir', '..', 'real-dir'))).toBe(true);
    // 不同位置
    expect(await sameRealPath(dir, path.join(tmp, 'other'))).toBe(false);
  });

  it('parseProgressSegment 解析本地化(中文)阶段名:git 界面语言为 zh 时进度条才有百分比', () => {
    // 回归:旧正则限定 [A-Za-z] 阶段名,中文系统("接收对象中")永远解析不出 pct,GUI 无进度条
    const zh = parseProgressSegment('remote: 接收对象中:   8% (31/377)\r');
    expect(zh).toMatchObject({ phase: '接收对象中', pct: 8, rest: '(31/377)', done: false });
    const zhDone = parseProgressSegment('处理 delta 中: 100% (52/52), 完成.');
    expect(zhDone).toMatchObject({ phase: '处理 delta 中', pct: 100, done: true });
    expect(zhDone?.rest).not.toContain('完成');
    // 英文输出照常解析
    const en = parseProgressSegment('Receiving objects:  45% (45/100), 1.0 MiB | 2.0 MiB/s');
    expect(en).toMatchObject({ phase: 'Receiving objects', pct: 45 });
    // 非进度行(Cloning into... / 正克隆到...)不解析百分比
    expect(parseProgressSegment("Cloning into '/tmp/x'...")?.phase).toBeNull();
    expect(parseProgressSegment("正克隆到 '/tmp/x'...")?.phase).toBeNull();
    expect(parseProgressSegment('   ')).toBeNull();
  });

  it('summarizeStderr 剥掉本地化进度行,保留真实错误原因', () => {
    const stderr = [
      "正克隆到 '/tmp/x'...",
      '接收对象中:  50% (50/100), 1.0 MiB | 2.0 MiB/s',
      '接收对象中: 100% (100/100), 完成.',
      "致命错误: 无法访问 'https://github.com/o/r.git/':Failed to connect",
    ].join('\r\n');
    const summary = summarizeStderr(stderr);
    expect(summary).toContain('致命错误');
    expect(summary).not.toContain('接收对象中');
  });

  /** 在伪仓库目录里写一个合法 skill:<repoDir>/<sub>/<name>/SKILL.md */
  async function writeFakeSkill(repoDir: string, sub: string, name: string): Promise<void> {
    const dir = path.join(repoDir, sub, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`, 'utf8');
  }

  it('registerSkillsWithFallback 根级落空时自动探测 skills/ 等合集子目录', async () => {
    // 模拟 addyosmani/agent-skills 布局:skills 收在 skills/ 子目录,根级无 SKILL.md
    const repoDir = path.join(tmp, 'fake-repo');
    await writeFakeSkill(repoDir, 'skills', 'code-review');
    await writeFakeSkill(repoDir, 'skills', 'debugging');
    const found = await registerSkillsWithFallback(repoDir, 'o/r', 'o/r');
    expect(found.map((s) => s.id).sort()).toEqual(['o/r:skills/code-review', 'o/r:skills/debugging']);
  });

  it('registerSkillsWithFallback 根级有 skill 时不触发兜底(不重复登记子目录)', async () => {
    const repoDir = path.join(tmp, 'fake-repo');
    await writeFakeSkill(repoDir, '', 'root-skill'); // <repoDir>/root-skill/SKILL.md
    await writeFakeSkill(repoDir, 'skills', 'nested-skill');
    const found = await registerSkillsWithFallback(repoDir, 'o/r2', 'o/r2');
    expect(found.map((s) => s.id)).toEqual(['o/r2:root-skill']);
  });

  it('registerSkillsWithFallback 显式 subdir 不兜底:子目录不存在直接报错', async () => {
    const repoDir = path.join(tmp, 'fake-repo');
    await writeFakeSkill(repoDir, 'skills', 'code-review');
    await expect(registerSkillsWithFallback(repoDir, 'o/r3', 'o/r3', 'nope')).rejects.toThrow('不存在子目录');
  });
});

/**
 * 技能库更新检查:全部走本地 git 仓库(init → bare remote → clone 进库),
 * 不打真实 GitHub;updateSkill 内部的 fetchRepoStars 用假 fetch 短路(软失败保留旧值)。
 */
describe('技能库更新检查(checkLibraryUpdates / applyLibraryUpdates)', () => {
  const execFileP = promisify(execFile);
  const git = (args: string[]) => execFileP('git', args);

  /** 造一个可推可拉的本地"远程"仓库并把克隆放进库目录,登记一个 github 条目 */
  async function seedCloneRepo(ownerRepo: string): Promise<{ repoDir: string; workDir: string }> {
    const [owner, repo] = ownerRepo.split('/');
    const remoteDir = path.join(tmp, `remote-${owner}-${repo}.git`);
    const workDir = path.join(tmp, `work-${owner}-${repo}`);
    await git(['init', '--bare', '-b', 'main', remoteDir]);
    await git(['init', '-b', 'main', workDir]);
    const skillDir = path.join(workDir, 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 测试技能\n---\n\n# demo\n');
    await git(['-C', workDir, 'add', '.']);
    await git(['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
    await git(['-C', workDir, 'remote', 'add', 'origin', remoteDir]);
    await git(['-C', workDir, 'push', '-u', 'origin', 'main']);
    const repoDir = path.join(libraryDir(), `github__${owner}__${repo}`);
    await git(['clone', remoteDir, repoDir]);
    const entry: SkillEntry = {
      id: `${ownerRepo}:demo`,
      name: 'demo',
      description: '测试技能',
      source: { type: 'github', uri: ownerRepo },
      tags: [],
      installedAt: new Date().toISOString(),
    };
    await upsertSkill(entry);
    return { repoDir, workDir };
  }

  /** 往 work 仓库推一个新提交(模拟上游更新) */
  async function pushUpstreamCommit(workDir: string): Promise<void> {
    await fs.writeFile(path.join(workDir, 'demo', 'extra.md'), 'v2');
    await git(['-C', workDir, 'add', '.']);
    await git(['-C', workDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v2']);
    await git(['-C', workDir, 'push']);
  }

  beforeEach(() => {
    // updateSkill 会顺带刷 stars(软失败);短路掉对 api.github.com 的真实请求
    vi.stubGlobal('fetch', (async () => new Response('{}', { status: 404 })) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('空库:ok 且 updates 为空', async () => {
    const r = await checkLibraryUpdates();
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual([]);
  });

  it('检查 → 发现落后 → 一键更新 → 库内文件刷新且徽标清除', async () => {
    const { workDir } = await seedCloneRepo('o/upd-lib');

    const r1 = await checkLibraryUpdates();
    expect(r1.ok).toBe(true);
    expect(r1.updates).toHaveLength(1);
    expect(r1.updates[0]).toMatchObject({ repoId: 'o/upd-lib', behind: 0, skillIds: ['o/upd-lib:demo'] });
    expect(getLastLibraryUpdates()?.updates[0].behind).toBe(0);

    await pushUpstreamCommit(workDir);
    const r2 = await checkLibraryUpdates();
    expect(r2.updates[0].behind).toBe(1);

    const applied = await applyLibraryUpdates();
    expect(applied.failed).toEqual([]);
    expect(applied.updated).toEqual(['o/upd-lib:demo']);
    // 库内文件已更新到 v2
    expect(await fs.readFile(path.join(libraryDir(), 'github__o__upd-lib', 'demo', 'extra.md'), 'utf8')).toBe('v2');
    // 更新成功的仓库即时从"可更新"清单摘掉,不必等下次 fetch
    expect(getLastLibraryUpdates()?.updates[0].behind).toBe(0);
  });

  it('克隆目录缺失:该仓记 error,不影响整体 ok;apply 跳过 error 仓库', async () => {
    const entry: SkillEntry = {
      id: 'o/ghost:x',
      name: 'x',
      description: 'd',
      source: { type: 'github', uri: 'o/ghost' },
      tags: [],
      installedAt: new Date().toISOString(),
    };
    await upsertSkill(entry);
    const r = await checkLibraryUpdates();
    expect(r.ok).toBe(true);
    expect(r.updates[0].error).toContain('缺失');
    const applied = await applyLibraryUpdates();
    expect(applied.updated).toEqual([]);
    expect(applied.failed).toEqual([]);
  });

  it('并发检查共享同一次在途请求(结果对象同一引用)', async () => {
    await seedCloneRepo('o/upd-conc');
    const [a, b] = await Promise.all([checkLibraryUpdates(), checkLibraryUpdates()]);
    expect(a).toBe(b);
    expect(a.ok).toBe(true);
  });
});
