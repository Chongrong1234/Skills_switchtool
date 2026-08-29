/**
 * library 测试:initSkill 脚手架合法、local 安装复制目录、SKILL.md 缺失拒绝安装、卸载、git 超时快速报错。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initSkill,
  installFromGithub,
  installFromLocal,
  parseFrontmatter,
  sameRealPath,
  skillDirOf,
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
});
