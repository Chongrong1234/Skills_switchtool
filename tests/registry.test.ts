/**
 * registry 测试:CRUD、原子写、损坏 JSON 容错。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registryFile } from '../src/core/paths.js';
import { getSkill, readRegistry, removeSkill, upsertSkill, writeRegistry } from '../src/core/registry.js';
import type { SkillEntry } from '../src/core/types.js';

let tmp: string;

function makeEntry(id: string): SkillEntry {
  return {
    id,
    name: id,
    description: `desc of ${id}`,
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

describe('registry', () => {
  it('初始为空注册表(文件不存在时容错)', async () => {
    expect(await readRegistry()).toEqual([]);
  });

  it('upsert 新增并可读取', async () => {
    await upsertSkill(makeEntry('local:a'));
    await upsertSkill(makeEntry('local:b'));
    const skills = await readRegistry();
    expect(skills.map((s) => s.id).sort()).toEqual(['local:a', 'local:b']);
    expect((await getSkill('local:a'))?.description).toBe('desc of local:a');
  });

  it('upsert 同 id 覆盖而非追加', async () => {
    await upsertSkill(makeEntry('local:a'));
    const updated = { ...makeEntry('local:a'), description: 'new desc' };
    await upsertSkill(updated);
    const skills = await readRegistry();
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('new desc');
  });

  it('removeSkill 删除记录', async () => {
    await upsertSkill(makeEntry('local:a'));
    expect(await removeSkill('local:a')).toBe(true);
    expect(await readRegistry()).toEqual([]);
    expect(await removeSkill('local:a')).toBe(false); // 再删返回 false
  });

  it('写入是原子的:registry.json 内容完整且无 tmp 残留', async () => {
    await writeRegistry([makeEntry('local:a')]);
    const raw = await fs.readFile(registryFile(), 'utf8');
    expect(JSON.parse(raw).skills).toHaveLength(1);
    const leftovers = (await fs.readdir(tmp)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('损坏 JSON 容错为空注册表', async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(registryFile(), '{ not valid json !!!', 'utf8');
    expect(await readRegistry()).toEqual([]);
  });

  it('结构非法(非对象)也容错', async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(registryFile(), '[1,2,3]', 'utf8');
    expect(await readRegistry()).toEqual([]);
  });

  it('rename 瞬时 EPERM(如 Windows 杀软持锁)退避重试后写入成功', async () => {
    const origRename = fs.rename;
    let calls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return origRename(src, dst);
    });
    try {
      await writeRegistry([makeEntry('local:a')]);
      expect((await readRegistry()).map((s) => s.id)).toEqual(['local:a']);
      expect(calls).toBeGreaterThanOrEqual(2); // 第一次失败,重试成功
    } finally {
      spy.mockRestore();
    }
  });
});
