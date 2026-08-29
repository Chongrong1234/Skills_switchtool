/**
 * adopt 收养测试:agent 目录里的已有 skills 收进中央库(逆向于 apply)。
 * 用项目级作用域 + 临时项目目录,不触碰真实 home。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../src/adapters/claude-code.js';
import { adoptFromAgent, initSkill, LibraryError, skillDirOf } from '../src/core/library.js';
import { getSkill } from '../src/core/registry.js';

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

const skillsDir = () => claudeCode.projectSkillsDir(projectPath);

async function mkAgentSkill(name: string): Promise<void> {
  const dir = path.join(skillsDir(), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 描述\n---\n`, 'utf8');
}

describe('adoptFromAgent', () => {
  it('收养合法目录、跳过我们 apply 出去的 symlink、非法目录记入 invalid', async () => {
    // agent 目录里:两个用户自攒的合法 skill + 一个无 SKILL.md 的坏目录 + 一个是我们 apply 的 symlink
    await mkAgentSkill('self-made-a');
    await mkAgentSkill('self-made-b');
    await fs.mkdir(path.join(skillsDir(), 'broken'), { recursive: true });
    const ours = await initSkill('ours', '已在库中');
    await fs.symlink(skillDirOf(ours), path.join(skillsDir(), 'ours'), process.platform === 'win32' ? 'junction' : 'dir');

    const r = await adoptFromAgent('claude-code', { scope: 'project', projectPath });
    expect(r.adopted.map((s) => s.id).sort()).toEqual(['local:self-made-a', 'local:self-made-b']);
    expect(r.skipped).toContain('ours');
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0].dir).toContain('broken');

    // 收养的条目是 local 来源,uri 记录来源路径;文件已复制进库
    const entry = await getSkill('local:self-made-a');
    expect(entry?.source.type).toBe('local');
    expect(entry?.source.uri).toContain('self-made-a');
    expect(await fs.readFile(path.join(skillDirOf(entry!), 'SKILL.md'), 'utf8')).toContain('self-made-a');
  });

  it('幂等:二次 adopt 全部跳过', async () => {
    await mkAgentSkill('self-made-a');
    await adoptFromAgent('claude-code', { scope: 'project', projectPath });
    const second = await adoptFromAgent('claude-code', { scope: 'project', projectPath });
    expect(second.adopted).toEqual([]);
    expect(second.skipped).toContain('self-made-a');
  });

  it('未知 agent / 目录不存在 / project 作用域缺 projectPath 都抛 LibraryError', async () => {
    await expect(adoptFromAgent('nope', { scope: 'project', projectPath })).rejects.toThrow(LibraryError);
    await expect(adoptFromAgent('claude-code', { scope: 'project', projectPath: path.join(tmp, 'ghost') })).rejects.toThrow(LibraryError);
    await expect(adoptFromAgent('claude-code', { scope: 'project' })).rejects.toThrow(LibraryError);
  });
});
