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
    // mock child_process.execFile 为 ENOENT(library.ts 顶层 promisify 包装它)
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => {
      const orig = await importOriginal<typeof import('node:child_process')>();
      return {
        ...orig,
        execFile: (...args: unknown[]) => {
          const cb = args[args.length - 1] as (e: Error) => void;
          cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
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
