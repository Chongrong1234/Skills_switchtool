/**
 * projects 测试:CRUD、activeProjectId 管理、损坏 JSON 容错。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectsFile } from '../src/core/paths.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setActiveProject,
  setProjectSkills,
  updateProject,
} from '../src/core/projects.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('projects', () => {
  it('创建/读取/列表', async () => {
    const p = await createProject({ name: 'demo', path: '/tmp/demo', agents: ['claude-code'], applyMode: 'symlink' });
    expect(p.id).toBeTruthy();
    expect(p.skills).toEqual([]);
    expect((await getProject(p.id))?.name).toBe('demo');
    const data = await listProjects();
    expect(data.projects).toHaveLength(1);
    expect(data.activeProjectId).toBeNull();
  });

  it('updateProject 部分更新', async () => {
    const p = await createProject({ name: 'demo', path: '/tmp/demo', agents: [], applyMode: 'symlink' });
    const updated = await updateProject(p.id, { name: 'renamed', applyMode: 'copy' });
    expect(updated?.name).toBe('renamed');
    expect(updated?.applyMode).toBe('copy');
    expect(updated?.path).toBe('/tmp/demo'); // 未动字段保持
    expect(await updateProject('no-such-id', { name: 'x' })).toBeUndefined();
  });

  it('setProjectSkills 绑定技能集', async () => {
    const p = await createProject({ name: 'demo', path: '/tmp/demo', agents: [], applyMode: 'symlink' });
    await setProjectSkills(p.id, ['local:a', 'local:b']);
    expect((await getProject(p.id))?.skills).toEqual(['local:a', 'local:b']);
  });

  it('activeProjectId 设置/切换/删除项目时清除', async () => {
    const a = await createProject({ name: 'a', path: '/a', agents: [], applyMode: 'symlink' });
    const b = await createProject({ name: 'b', path: '/b', agents: [], applyMode: 'symlink' });
    await setActiveProject(a.id);
    expect((await listProjects()).activeProjectId).toBe(a.id);
    await setActiveProject(b.id);
    expect((await listProjects()).activeProjectId).toBe(b.id);
    await deleteProject(b.id);
    expect((await listProjects()).activeProjectId).toBeNull();
    await expect(setActiveProject('ghost')).rejects.toThrow('项目不存在');
  });

  it('deleteProject 返回是否存在', async () => {
    const p = await createProject({ name: 'a', path: '/a', agents: [], applyMode: 'symlink' });
    expect(await deleteProject(p.id)).toBe(true);
    expect(await deleteProject(p.id)).toBe(false);
  });

  it('projects.json 损坏时容错为空', async () => {
    await fs.writeFile(projectsFile(), '### broken', 'utf8');
    const data = await listProjects();
    expect(data.projects).toEqual([]);
    expect(data.activeProjectId).toBeNull();
  });
});
