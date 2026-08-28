/**
 * migrate 测试:迁移码的导出/解析/导入。
 * 导入测试注入假 installFn,不做真实 git clone(同 recommend 注入 fetch 的约定)。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryError } from '../src/core/library.js';
import { exportSkillsCode, importSkillsCode, parseSkillsCode } from '../src/core/migrate.js';
import { upsertSkill } from '../src/core/registry.js';
import type { SkillEntry } from '../src/core/types.js';

let tmp: string;

function ghEntry(id: string): SkillEntry {
  return {
    id,
    name: id,
    description: `desc of ${id}`,
    source: { type: 'github', uri: `https://github.com/${id.split(':')[0]}` },
    tags: [],
    installedAt: new Date().toISOString(),
  };
}

function localEntry(name: string): SkillEntry {
  return {
    id: `local:${name}`,
    name,
    description: `desc of ${name}`,
    source: { type: 'local', uri: '/x' },
    tags: [],
    installedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('migrate: export', () => {
  it('只含 github 来源,按仓库去重并排序(同仓库子路径条目只出现一次)', () => {
    const code = exportSkillsCode([
      ghEntry('b/repo:sub'),
      ghEntry('a/repo:'),
      ghEntry('b/repo:'),
      localEntry('mine'),
    ]);
    expect(code).toBe('ssw1:a/repo,b/repo');
  });

  it('空库 / 无 github 来源时输出空前缀', () => {
    expect(exportSkillsCode([])).toBe('ssw1:');
    expect(exportSkillsCode([localEntry('x')])).toBe('ssw1:');
  });
});

describe('migrate: parse', () => {
  it('容忍空白/换行混排并去重', () => {
    expect(parseSkillsCode('  ssw1:a/b, c/d\ne/f,a/b\n')).toEqual(['a/b', 'c/d', 'e/f']);
  });

  it('空前缀返回空数组', () => {
    expect(parseSkillsCode('ssw1:')).toEqual([]);
  });

  it('拒绝错误前缀与非法条目', () => {
    expect(() => parseSkillsCode('a/b,c/d')).toThrow(LibraryError);
    expect(() => parseSkillsCode('ssw2:a/b')).toThrow(LibraryError);
    expect(() => parseSkillsCode('ssw1:a/b,nope')).toThrow(LibraryError);
    expect(() => parseSkillsCode('')).toThrow(LibraryError);
  });

  it('export → parse 往返一致', () => {
    const code = exportSkillsCode([ghEntry('x/y:'), ghEntry('m/n:sub')]);
    expect(parseSkillsCode(code)).toEqual(['m/n', 'x/y']);
  });
});

describe('migrate: import', () => {
  it('幂等:已在库中的仓库跳过,不重复安装', async () => {
    await upsertSkill(ghEntry('a/b:'));
    const calls: string[] = [];
    const r = await importSkillsCode('ssw1:a/b,c/d', async (uri) => {
      calls.push(uri);
      return [];
    });
    expect(r.skipped).toEqual(['a/b']);
    expect(r.installed).toEqual(['c/d']);
    expect(r.failed).toEqual([]);
    expect(calls).toEqual(['c/d']);
  });

  it('单仓失败不中断其余,记入 failed', async () => {
    const r = await importSkillsCode('ssw1:bad/repo,good/repo', async (uri) => {
      if (uri === 'bad/repo') throw new LibraryError('clone 失败');
      return [];
    });
    expect(r.installed).toEqual(['good/repo']);
    expect(r.failed).toEqual([{ repo: 'bad/repo', message: 'clone 失败' }]);
  });

  it('空码什么都不做', async () => {
    const r = await importSkillsCode('ssw1:');
    expect(r).toEqual({ installed: [], skipped: [], failed: [] });
  });

  it('非法迁移码直接抛 LibraryError', async () => {
    await expect(importSkillsCode('not-a-code')).rejects.toThrow(LibraryError);
  });
});
