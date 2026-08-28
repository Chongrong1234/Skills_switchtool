/**
 * apply/unapply/rollback 测试:临时目录模拟 agent 项目目录 + 中央库。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProject, unapplyProject } from '../src/core/apply.js';
import { initSkill, skillDirOf } from '../src/core/library.js';
import { createProject, setProjectSkills } from '../src/core/projects.js';
import { listSnapshots, rollback } from '../src/core/snapshot.js';
import { claudeCode } from '../src/adapters/claude-code.js';
import { kimiCode } from '../src/adapters/kimi-code.js';

let tmp: string;
let projectPath: string;

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
  // 项目目录(模拟真实项目根)
  projectPath = path.join(tmp, 'my-project');
  await fs.mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('apply', () => {
  it('apply 后各 agent 目录出现指向库内的 symlink', async () => {
    const skill = await initSkill('demo-skill', '演示');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code', 'kimi-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);

    const result = await applyProject(project.id);
    expect(result.applied).toHaveLength(2);

    for (const adapter of [claudeCode, kimiCode]) {
      const dest = path.join(adapter.projectSkillsDir(projectPath), 'demo-skill');
      const st = await fs.lstat(dest);
      expect(st.isSymbolicLink()).toBe(true);
      // 指向库内真实目录
      expect(await fs.realpath(dest)).toBe(await fs.realpath(skillDirOf(skill)));
    }
    // 更新 lastAppliedAt
    expect(result.warnings).toEqual([]);
  });

  it('copy 模式物化为真实目录', async () => {
    const skill = await initSkill('copy-skill', '复制模式');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'copy',
    });
    await setProjectSkills(project.id, [skill.id]);
    await applyProject(project.id);

    const dest = path.join(claudeCode.projectSkillsDir(projectPath), 'copy-skill');
    const st = await fs.lstat(dest);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toContain('copy-skill');
  });

  it('同名冲突时旧目录被移入快照,rollback 可还原', async () => {
    const skill = await initSkill('conflict-skill', '库里的版本');
    const skillsDir = claudeCode.projectSkillsDir(projectPath);
    const dest = path.join(skillsDir, 'conflict-skill');
    // 预先放一个同名的用户目录(内容不同)
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'SKILL.md'), '---\nname: conflict-skill\ndescription: 用户手写版\n---\n', 'utf8');
    await fs.writeFile(path.join(dest, 'user-note.txt'), '用户的重要笔记', 'utf8');

    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);
    await applyProject(project.id);

    // 旧目录被移走,dest 现在是指向库的 symlink
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
    // 快照里能找到被移走的用户文件
    const snaps = await listSnapshots(project.id);
    expect(snaps).toHaveLength(1);
    const moved = path.join(
      tmp, 'snapshots', project.id, snaps[0], 'conflicts', 'claude-code', 'conflict-skill', 'user-note.txt',
    );
    expect(await fs.readFile(moved, 'utf8')).toBe('用户的重要笔记');

    // rollback:还原冲突前的目录
    const rb = await rollback(project.id);
    expect(rb.restored).toBe(true);
    const st = await fs.lstat(dest);
    expect(st.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(dest, 'user-note.txt'), 'utf8')).toBe('用户的重要笔记');
    // 快照已消费
    expect(await listSnapshots(project.id)).toHaveLength(0);
  });

  it('unapply 后目标目录干净', async () => {
    const skill = await initSkill('rm-skill', '要被移除');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code', 'kimi-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);
    await applyProject(project.id);

    const { removed } = await unapplyProject(project.id);
    expect(removed).toHaveLength(2);
    for (const adapter of [claudeCode, kimiCode]) {
      expect(await realpathOrNull(path.join(adapter.projectSkillsDir(projectPath), 'rm-skill'))).toBeNull();
    }
  });

  it('apply 幂等:重复 apply 不产生重复项', async () => {
    const skill = await initSkill('idem-skill', '幂等');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'symlink',
    });
    await setProjectSkills(project.id, [skill.id]);
    await applyProject(project.id);
    const second = await applyProject(project.id);
    expect(second.applied).toHaveLength(0); // 已是正确链接,跳过
  });

  it('快照每项目最多保留 5 份', async () => {
    const skill = await initSkill('prune-skill', '裁剪');
    const project = await createProject({
      name: 'demo',
      path: projectPath,
      agents: ['claude-code'],
      applyMode: 'copy', // copy 模式每次都会真实物化,保证每份快照非空
    });
    await setProjectSkills(project.id, [skill.id]);
    for (let i = 0; i < 7; i++) {
      await unapplyProject(project.id);
      await applyProject(project.id);
    }
    expect((await listSnapshots(project.id)).length).toBeLessThanOrEqual(5);
  });
});
