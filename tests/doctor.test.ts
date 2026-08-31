/**
 * doctor 环境自检测试:数据目录可写/git 探活/agent 检测/JSON 数据文件健康度 + 统计。
 * SSW_HOME 隔离到临时目录;git 与 agent 检测依赖真实环境,断言只落在结构与不变性上
 * (git 缺失只是 warn、agent 零检测也只是 warn,都不影响 ok)。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/core/doctor.js';
import { initSkill } from '../src/core/library.js';
import { registryFile } from '../src/core/paths.js';
import { createProject, setActiveProject } from '../src/core/projects.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-doctor-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runDoctor', () => {
  it('全新环境:结构完整,数据文件缺失视为首用正常,统计全零', async () => {
    const r = await runDoctor();
    expect(r.sswHome).toBe(tmp);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['ssw-home', 'git', 'agents', 'registry', 'projects', 'mcps', 'global', 'update']);
    // 数据文件尚不存在 → ok 级并标注首次使用(不是损坏)
    for (const id of ['registry', 'projects', 'mcps', 'global', 'update']) {
      const c = r.checks.find((x) => x.id === id)!;
      expect(c.level).toBe('ok');
      expect(c.label).toContain('首次使用');
    }
    expect(r.stats).toEqual({ skills: 0, mcps: 0, projects: 0, activeProject: null });
  });

  it('损坏的 registry.json → error 级、ok=false,附修复 hint(运行时会容错成空,必须显式暴露)', async () => {
    await fs.writeFile(registryFile(), '{oops', 'utf8');
    const r = await runDoctor();
    const c = r.checks.find((x) => x.id === 'registry')!;
    expect(c.level).toBe('error');
    expect(c.label).toContain('损坏');
    expect(c.hint).toBeTruthy();
    expect(r.ok).toBe(false);
  });

  it('统计反映库内容:skill 数、项目数、激活项目名', async () => {
    await initSkill('demo-skill', 'demo');
    const p = await createProject({ name: 'demo-proj', path: tmp, agents: ['claude-code'], applyMode: 'symlink' });
    await setActiveProject(p.id);
    const r = await runDoctor();
    expect(r.stats.skills).toBe(1);
    expect(r.stats.projects).toBe(1);
    expect(r.stats.activeProject).toBe('demo-proj');
  });
});
