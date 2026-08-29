/**
 * 平台兼容性(Windows)专项测试:
 * - symlink 失败(EPERM,Windows 无开发者权限)时 apply 自动降级 copy 并告警
 * - git 不在 PATH(spawn ENOENT)时给出可读错误而非裸崩溃
 * - skill 名称非法(含 Windows 保留名 CON/PRN 等)时拒绝安装/创建
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProject } from '../src/core/apply.js';
import { assertValidSkillName, initSkill, installFromLocal, skillDirOf } from '../src/core/library.js';
import { createProject, setProjectSkills } from '../src/core/projects.js';
import { listSnapshots, rollback } from '../src/core/snapshot.js';
import { claudeCode } from '../src/adapters/claude-code.js';

let tmp: string;
let projectPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
  projectPath = path.join(tmp, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Windows 兼容:symlink 降级', () => {
  it('symlink 抛 EPERM 时自动降级 copy 并产生告警', async () => {
    const skill = await initSkill('win-skill', '降级测试');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);

    // 模拟 Windows 无权限:symlink 一律 EPERM
    vi.spyOn(fs, 'symlink').mockRejectedValue(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );

    const result = await applyProject(project.id);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].mode).toBe('copy');
    expect(result.warnings.some((w) => w.includes('降级'))).toBe(true);

    // 目标位置是真实目录而非链接,内容完整
    const dest = path.join(claudeCode.projectSkillsDir(projectPath), 'win-skill');
    const st = await fs.lstat(dest);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toContain('win-skill');
  });
});

describe('Windows 兼容:git 缺失的可读错误', () => {
  it('spawn git ENOENT 时报"未找到 git 命令"而不是裸崩溃', async () => {
    // mock child_process.spawn 为 ENOENT(library.ts 用 spawn 流式读 stderr 渲染进度条)
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => {
      const orig = await importOriginal<typeof import('node:child_process')>();
      const { EventEmitter } = await import('node:events');
      return {
        ...orig,
        spawn: (..._args: unknown[]) => {
          // 最小可用假 ChildProcess:stdin.end/stdout/stderr/kill + 异步发 ENOENT 的 error 事件
          const fake = Object.assign(new EventEmitter(), {
            stdin: { end: () => undefined },
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => true,
          });
          queueMicrotask(() =>
            fake.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })),
          );
          return fake;
        },
      };
    });
    const { installFromGithub } = await import('../src/core/library.js');
    await expect(installFromGithub('owner/repo')).rejects.toThrow('未找到 git 命令');
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });
});

describe('Windows 兼容:skill 名称合法性', () => {
  it('Windows 保留名被拒绝', () => {
    for (const bad of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
      expect(() => assertValidSkillName(bad)).toThrow('保留文件名');
    }
  });

  it('含冒号/斜杠/大写等非法字符被拒绝', () => {
    for (const bad of ['a:b', 'a/b', 'Bad', '_x', '']) {
      expect(() => assertValidSkillName(bad)).toThrow('非法');
    }
  });

  it('合法名称通过', () => {
    for (const ok of ['a', 'my-skill', 'x1', 'node18']) {
      expect(() => assertValidSkillName(ok)).not.toThrow();
    }
  });

  it('initSkill 拒绝 Windows 保留名', async () => {
    await expect(initSkill('con', 'x')).rejects.toThrow('保留文件名');
  });

  it('installFromLocal 拒绝非法 frontmatter name', async () => {
    const src = path.join(tmp, 'bad-skill');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: prn\ndescription: 保留名\n---\n', 'utf8');
    await expect(installFromLocal(src)).rejects.toThrow('保留文件名');
  });
});

describe('Windows 兼容:降级 copy 后的 apply 幂等', () => {
  it('symlink EPERM 降级 copy 后,重复 apply 跳过副本(不再误当冲突移入快照)', async () => {
    const skill = await initSkill('win-idem', '降级幂等');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);

    vi.spyOn(fs, 'symlink').mockRejectedValue(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );
    const first = await applyProject(project.id);
    expect(first.applied[0].mode).toBe('copy');

    const second = await applyProject(project.id);
    expect(second.applied).toHaveLength(0); // 副本被认出是"我们的",幂等跳过
    expect(await listSnapshots(project.id)).toHaveLength(1); // 没有多余快照
  });
});

describe('跨设备移动(rename EXDEV,Windows C:/D: 盘场景)', () => {
  it('冲突移入快照与回滚还原都降级为 复制+删除,内容完整', async () => {
    const skill = await initSkill('exdev-skill', 'EXDEV 测试');
    const skillsDir = claudeCode.projectSkillsDir(projectPath);
    const dest = path.join(skillsDir, 'exdev-skill');
    // 预先放一个同名的用户目录
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'SKILL.md'), '---\nname: exdev-skill\ndescription: 用户旧版\n---\n', 'utf8');
    await fs.writeFile(path.join(dest, 'note.txt'), '用户数据', 'utf8');

    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);

    // 模拟跨设备:涉及项目目录的 rename 一律 EXDEV(注册表/快照内部移动仍走真实 rename)
    // 注意带路径分隔符比较:"tmp/proj" 是 "tmp/projects.json" 的裸前缀
    const origRename = fs.rename;
    const underProject = (p: unknown) => String(p).startsWith(projectPath + path.sep);
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (underProject(src) || underProject(dst)) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      }
      return origRename(src, dst);
    });

    const result = await applyProject(project.id);
    expect(result.applied).toHaveLength(1);
    // 用户旧目录完整进了快照
    const snaps = await listSnapshots(project.id);
    expect(snaps).toHaveLength(1);
    const moved = path.join(
      tmp, 'snapshots', project.id, snaps[0], 'conflicts', 'claude-code', 'exdev-skill', 'note.txt',
    );
    expect(await fs.readFile(moved, 'utf8')).toBe('用户数据');

    // 回滚同样跨设备,仍能还原
    const rb = await rollback(project.id);
    expect(rb.restored).toBe(true);
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(dest, 'note.txt'), 'utf8')).toBe('用户数据');
  });
});
