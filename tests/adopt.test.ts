/**
 * adopt 收养测试:agent 目录里的已有 skills 收进中央库(逆向于 apply)。
 * 用项目级作用域 + 临时项目目录,不触碰真实 home。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../src/adapters/claude-code.js';
import { adoptFromAgent, adoptFromAllAgents, initSkill, LibraryError, skillDirOf } from '../src/core/library.js';
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

describe('adoptFromAllAgents(一键收养所有 agent)', () => {
  const mkSkillAt = async (dir: string, name: string) => {
    const d = path.join(dir, name);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 描述\n---\n`, 'utf8');
  };

  it('user 级:扫描所有检测到的 agent,跨 agent 同名去重,未安装的跳过不报错', async () => {
    const home = path.join(tmp, 'fake-home');
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      // 两台"已安装"的 agent:~/.claude/skills/own-a;~/.kimi-code/skills/own-b + own-a(重名)
      await mkSkillAt(path.join(home, '.claude', 'skills'), 'own-a');
      await mkSkillAt(path.join(home, '.kimi-code', 'skills'), 'own-b');
      await mkSkillAt(path.join(home, '.kimi-code', 'skills'), 'own-a');

      const r = await adoptFromAllAgents({ scope: 'user' });
      expect(r.adopted.map((s) => s.id).sort()).toEqual(['local:own-a', 'local:own-b']);
      expect(r.skipped).toContain('own-a'); // kimi-code 里的重名副本
      expect(r.scanned.map((s) => s.agent)).toEqual(expect.arrayContaining(['claude-code', 'kimi-code']));
      expect(r.skippedAgents.length).toBeGreaterThan(0); // 未安装的 agent 不报错,记入 skippedAgents

      // 幂等:再扫一次全跳过
      const second = await adoptFromAllAgents({ scope: 'user' });
      expect(second.adopted).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('project 级:共享 .agents/skills 的多家只扫一次;缺 projectPath 抛 LibraryError', async () => {
    await mkSkillAt(path.join(projectPath, '.claude', 'skills'), 'p-skill');
    await mkSkillAt(path.join(projectPath, '.agents', 'skills'), 'shared-one');

    const r = await adoptFromAllAgents({ scope: 'project', projectPath });
    expect(r.adopted.map((s) => s.id).sort()).toEqual(['local:p-skill', 'local:shared-one']);
    // agents/copilot/opencode 同指 .agents/skills:注册表顺序里 agents 先扫,另两家记"同目录"
    const dupSkipped = r.skippedAgents.filter((s) => s.reason.includes('同目录')).map((s) => s.agent).sort();
    expect(dupSkipped).toEqual(['copilot', 'opencode']);

    await expect(adoptFromAllAgents({ scope: 'project' })).rejects.toThrow(LibraryError);
  });

  it('桌面服务启动(startServer)自动收养本机 agent 的用户级 skills', async () => {
    const home = path.join(tmp, 'fake-home-auto');
    await mkSkillAt(path.join(home, '.claude', 'skills'), 'auto-one');
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const { startServer, serverPort } = await import('../src/serve.js');
    let server: import('node:http').Server | undefined;
    try {
      server = await startServer(0, '127.0.0.1');
      expect(serverPort(server)).toBeGreaterThan(0);
      // 服务就绪时注册表里已有自动收养的条目
      const { readRegistry } = await import('../src/core/registry.js');
      expect((await readRegistry()).map((s) => s.id)).toContain('local:auto-one');
    } finally {
      spy.mockRestore();
      if (server) await new Promise((resolve) => server!.close(resolve));
    }
  });
});
