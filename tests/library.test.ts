/**
 * library 测试:initSkill 脚手架合法、local 安装复制目录、SKILL.md 缺失拒绝安装、卸载。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initSkill,
  installFromLocal,
  parseFrontmatter,
  skillDirOf,
  uninstall,
  validateSkillDir,
} from '../src/core/library.js';
import { getSkill } from '../src/core/registry.js';

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
    expect(await uninstall(entry.id)).toBe(true);
    expect(await getSkill(entry.id)).toBeUndefined();
    await expect(fs.access(skillDirOf(entry))).rejects.toThrow();
    expect(await uninstall(entry.id)).toBe(false);
  });
});
