#!/usr/bin/env node
/**
 * ssw / skills —— Skills SwitchTool 命令行版(服务器/无 GUI 环境用)。
 * 子命令为纯命令行非交互;全部子命令映射 core 能力;全局 --json 输出便于脚本化。
 * 不带任何参数启动(TTY 下)时进入交互式终端面板(见 tui.ts);非 TTY 则打印帮助。
 * 错误输出到 stderr 且退出码非零;成功输出到 stdout。
 */
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { adapters, getAdapter } from './adapters/index.js';
import { applyProject, unapplyProject } from './core/apply.js';
import { applyGlobal, readGlobal, rollbackGlobal, unapplyGlobal, updateGlobal } from './core/global.js';
import { exportProfile, importProfile } from './core/profile.js';
import {
  adoptFromAgent,
  adoptFromAllAgents,
  checkLibraryUpdates,
  initSkill,
  installFromGithub,
  installFromLocal,
  listSkills,
  uninstall,
  updateSkill,
} from './core/library.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setActiveProject,
  setProjectMcps,
  setProjectSkills,
} from './core/projects.js';
import { listMcps, removeMcp, upsertMcp } from './core/mcps.js';
import { recommendForProject } from './core/recommend.js';
import {
  AI_PRESETS,
  aiRecommendSkills,
  readAiConfig,
  testAiConnection,
  toPublicConfig,
  updateAiConfig,
} from './core/ai.js';
import { CATALOG, listCatalogCategories, listCatalogWithInstalled, searchCatalogGithub } from './core/catalog.js';
import { exportSkillsCode, importSkillsCode, parseSkillsCode } from './core/migrate.js';
import { rollback } from './core/snapshot.js';
import { runDoctor } from './core/doctor.js';
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateDownload,
  openExternal,
  saveUpdateConfig,
} from './core/update.js';
import type { Project, SkillEntry } from './core/types.js';
import { readRegistry } from './core/registry.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('ssw')
  .description('Skills SwitchTool —— 项目中心化的 Agent Skills 管理工具(CLI)')
  .version(VERSION)
  .option('--json', '以 JSON 格式输出');

/** 叶子命令统一挂 --json(全局选项在子命令后不注册会报 unknown option) */
function leaf(cmd: Command): Command {
  return cmd.option('--json', '以 JSON 格式输出');
}

/** 输出:--json 时打 JSON,否则打人类可读文本 */
function out(cmd: Command, data: unknown, human: () => string): void {
  const json = (cmd.optsWithGlobals() as { json?: boolean }).json;
  console.log(json ? JSON.stringify(data, null, 2) : human());
}

function fail(err: unknown): never {
  console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  // 主动退出,避免意外残留的长驻句柄挂住进程
  process.exit(1);
}

/** 包装 action:统一错误处理;commander 约定最后一个实参是 Command 实例 */
function wrap(fn: (cmd: Command, ...args: never[]) => Promise<void>) {
  return async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    try {
      await fn(cmd, ...(args.slice(0, -1) as never[]));
    } catch (err) {
      fail(err);
    }
  };
}

/** id|name 寻址:先精确匹配 id,再按 name;歧义列出候选;找不到报错 */
async function findProject(ref: string): Promise<Project> {
  const { projects } = await listProjects();
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `名称 "${ref}" 匹配到多个项目,请改用 id:\n` +
        byName.map((p) => `  ${p.id}  ${p.name}  ${p.path}`).join('\n'),
    );
  }
  throw new Error(`找不到项目: ${ref}`);
}

/**
 * skill 的 id|name 寻址:库内 id 往往很长(local:x、owner/repo:subdir:skill),
 * 允许用唯一的 name 简写;歧义列出候选;找不到给出引导(保留"库中不存在"字样,测试依赖)。
 */
async function findSkill(ref: string): Promise<SkillEntry> {
  const registry = await readRegistry();
  const byId = registry.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = registry.filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `名称 "${ref}" 匹配到多个 skill,请改用 id:\n` +
        byName.map((s) => `  ${s.id}  ${s.name}`).join('\n'),
    );
  }
  throw new Error(`库中不存在 skill: ${ref}(用 ssw skill list 查看可用 id/名称)`);
}

/** 批量解析 skill 引用(id|name),保留输入顺序并按 id 去重 */
async function resolveSkillRefs(refs: string[]): Promise<SkillEntry[]> {
  const seen = new Set<string>();
  const resolved: SkillEntry[] = [];
  for (const ref of refs) {
    const s = await findSkill(ref);
    if (!seen.has(s.id)) {
      seen.add(s.id);
      resolved.push(s);
    }
  }
  return resolved;
}

/** ref 省略时用当前激活项目 */
async function resolveProject(ref: string | undefined): Promise<Project> {
  if (ref) return findProject(ref);
  const { activeProjectId } = await listProjects();
  if (!activeProjectId) throw new Error('未指定项目且没有当前激活项目(用 ssw project switch <id|name> 激活,或显式传项目参数)');
  const p = await getProject(activeProjectId);
  if (!p) throw new Error(`激活项目已不存在: ${activeProjectId}`);
  return p;
}

function fmtTime(iso?: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '(从未)';
}

// ---------- agents ----------
leaf(program.command('agents').description('列出各 agent 适配器及检测状态')).action(
  wrap(async (cmd) => {
    const list = adapters.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      detected: a.detect(),
      capabilities: a.capabilities,
    }));
    out(cmd, list, () =>
      list
        .map((a) => `${a.detected ? '✓' : '✗'} ${a.id.padEnd(14)} ${a.displayName}${a.detected ? '' : '  (未检测到)'}`)
        .join('\n'),
    );
  }),
);

// ---------- project ----------
const projectCmd = program.command('project').description('项目管理');

leaf(projectCmd.command('list').description('项目列表,* 为当前激活项')).action(
  wrap(async (cmd) => {
    const data = await listProjects();
    out(cmd, data, () => {
      if (!data.projects.length) return '(暂无项目,用 ssw project create 创建)';
      return data.projects
        .map((p) => {
          const mark = p.id === data.activeProjectId ? '*' : ' ';
          return `${mark} ${p.id.slice(0, 8)}  ${p.name.padEnd(16)} ${p.path}  [${p.agents.join(', ')}]  skills: ${p.skills.length}  mcps: ${p.mcps.length}`;
        })
        .join('\n');
    });
  }),
);

leaf(
  projectCmd
    .command('create')
    .description('创建项目')
    .requiredOption('--name <name>', '项目名称')
    .option('--path <path>', '项目根目录(缺省取当前工作目录)')
    .option('--agents <ids>', '目标 agents,逗号分隔(如 claude-code,kimi-code;缺省取本机检测到的 agent)')
    .option('--mode <mode>', 'apply 模式: symlink|copy', 'symlink')
    .option('--ai <requirement>', '用 AI 读技能库,按开发需求推荐并绑定技能(需先 ssw ai config 配置)'),
).action(
  wrap(async (cmd, opts: { name: string; path?: string; agents?: string; mode: string; ai?: string }) => {
    if (!['symlink', 'copy'].includes(opts.mode)) {
      throw new Error('--mode 只能是 symlink 或 copy');
    }
    // --agents 缺省取本机检测到的具体 agent(排除恒真的通用 'agents' 互操作目录);
    // 一个都没检测到说明环境异常,必须显式指定
    let agentIds: string[];
    let usedDefaultAgents = false;
    if (opts.agents === undefined) {
      agentIds = adapters.filter((a) => a.id !== 'agents' && a.detect()).map((a) => a.id);
      if (!agentIds.length) {
        throw new Error(`未检测到任何 agent,请显式指定 --agents(可用: ${adapters.map((a) => a.id).join(', ')};自检: ssw doctor)`);
      }
      usedDefaultAgents = true;
    } else {
      agentIds = opts.agents.split(',').map((s) => s.trim()).filter(Boolean);
    }
    for (const id of agentIds) {
      if (!getAdapter(id)) throw new Error(`未知 agent: ${id}(可用: ${adapters.map((a) => a.id).join(', ')})`);
    }
    // --path 缺省取当前工作目录:在项目根里跑命令时无需手填
    const p = await createProject({ name: opts.name, path: path.resolve(opts.path ?? '.'), agents: agentIds, applyMode: opts.mode as 'symlink' | 'copy' });
    // 允许同名项目,但同名会让 name 寻址歧义,主动提醒
    const { projects } = await listProjects();
    const sameName = projects.filter((x) => x.name === p.name && x.id !== p.id);
    // --ai:让模型读技能库按需求推荐,推荐结果直接并入新项目技能集(新项目原本是空集,等价整体替换)
    let aiRec: Awaited<ReturnType<typeof aiRecommendSkills>> | null = null;
    if (opts.ai) {
      aiRec = await aiRecommendSkills({ requirement: opts.ai, projectName: opts.name });
      if (aiRec.items.length) {
        const merged = [...new Set([...p.skills, ...aiRec.items.map((s) => s.id)])];
        await setProjectSkills(p.id, merged);
        p.skills = merged;
      }
    }
    out(cmd, { ...p, aiRecommend: aiRec }, () => {
      let s =
        `已创建项目 ${p.name}(${p.id})` +
        (usedDefaultAgents ? `\n目标 agents 取本机检测结果: ${agentIds.join(', ')}` : '') +
        (sameName.length ? `\n警告: 已存在同名项目「${p.name}」,后续寻址建议用 id` : '');
      if (aiRec) {
        s += `\nAI 推荐(${aiRec.model ?? '-'}):`;
        if (aiRec.items.length) {
          s += '\n' + aiRec.items.map((r) => `  ✓ ${r.id}  ${r.name}${r.reason ? `  — ${r.reason}` : ''}`).join('\n') +
            `\n已自动绑定 ${aiRec.items.length} 个技能到本项目`;
        } else {
          s += ` ${aiRec.message ?? '(无结果)'}`;
        }
        if (aiRec.github.length) {
          s += '\nGitHub 联网推荐(安装: ssw skill add --github <owner/repo>):' +
            '\n' + aiRec.github.map((g) => `  ★${g.stars}  ${g.repo}  ${g.description}`).join('\n');
        } else if (aiRec.githubMessage) {
          s += `\n(GitHub 联网推荐: ${aiRec.githubMessage})`;
        }
      }
      return s +
        (aiRec?.items.length
          ? `\n下一步: ssw project apply ${p.id} 使配置生效(不满意可 ssw project bind 调整)`
          : `\n下一步: ssw project bind ${p.id} <skillId|名称...> 绑定技能,然后 ssw project switch ${p.id}`);
    });
  }),
);

leaf(projectCmd.command('show').description('项目详情').argument('<id|name>', '项目 id 或名称')).action(
  wrap(async (cmd, ref: string) => {
    const p = await findProject(ref);
    const registry = await readRegistry();
    const skills = registry.filter((s) => p.skills.includes(s.id));
    const mcps = (await listMcps()).filter((m) => p.mcps.includes(m.name));
    const { activeProjectId } = await listProjects();
    const detail = { ...p, active: p.id === activeProjectId, skillDetails: skills, mcpDetails: mcps };
    out(cmd, detail, () => {
      const lines = [
        `项目: ${p.name} (${p.id})${p.id === activeProjectId ? '  [当前激活]' : ''}`,
        `路径: ${p.path}`,
        `apply 模式: ${p.applyMode}`,
        `目标 agents: ${p.agents.join(', ') || '(无)'}`,
        `上次 apply: ${fmtTime(p.lastAppliedAt)}`,
        `技能集(${skills.length}):`,
        ...skills.map((s) => `  ${s.id.padEnd(24)} ${s.name} - ${s.description}`),
        `MCP 服务集(${mcps.length}):`,
        ...mcps.map((m) => `  ${m.name.padEnd(24)} [${m.transport}]  ${m.transport === 'stdio' ? `${m.command} ${(m.args ?? []).join(' ')}` : m.url}`),
      ];
      return lines.join('\n');
    });
  }),
);

leaf(projectCmd.command('switch').description('设为当前项目并 apply').argument('<id|name>', '项目 id 或名称')).action(
  wrap(async (cmd, ref: string) => {
    const p = await findProject(ref);
    await setActiveProject(p.id);
    const result = await applyProject(p.id);
    out(cmd, { activeProjectId: p.id, ...result }, () => {
      const lines = [`已切换到「${p.name}」并应用配置(skills ${result.applied.length} 项,MCP ${result.mcpApplied.length} 项)`];
      for (const a of result.applied) lines.push(`  [${a.agentId}] ${a.skillName} -> ${a.target} (${a.mode})`);
      for (const m of result.mcpApplied) lines.push(`  [${m.agentId}] MCP ${m.mcpName} -> ${m.target}`);
      for (const w of result.warnings) lines.push(`  警告: ${w}`);
      return lines.join('\n');
    });
  }),
);

for (const [name, desc] of [
  ['apply', '应用项目技能集到各 agent 目录'],
  ['unapply', '移除项目的物化结果'],
  ['rollback', '回滚最近一次 apply 快照'],
] as const) {
  leaf(projectCmd.command(name).description(desc).argument('[id|name]', '项目 id 或名称,省略用当前激活项')).action(
    wrap(async (cmd, ref?: string) => {
      const p = await resolveProject(ref);
      if (name === 'apply') {
        const result = await applyProject(p.id);
        out(cmd, result, () => {
          const lines = [`已应用 skills ${result.applied.length} 项、MCP ${result.mcpApplied.length} 项(项目「${p.name}」)`];
          for (const a of result.applied) lines.push(`  [${a.agentId}] ${a.skillName} -> ${a.target} (${a.mode})`);
          for (const m of result.mcpApplied) lines.push(`  [${m.agentId}] MCP ${m.mcpName} -> ${m.target}`);
          for (const w of result.warnings) lines.push(`  警告: ${w}`);
          return lines.join('\n');
        });
      } else if (name === 'unapply') {
        const result = await unapplyProject(p.id);
        out(cmd, result, () => `已移除 ${result.removed.length} 项(项目「${p.name}」)`);
      } else {
        const result = await rollback(p.id);
        if (!result.restored) throw new Error(result.detail);
        out(cmd, result, () => result.detail);
      }
    }),
  );
}

leaf(projectCmd.command('remove').description('删除项目档案(不动磁盘文件)').argument('<id|name>', '项目 id 或名称')).action(
  wrap(async (cmd, ref: string) => {
    const p = await findProject(ref);
    await deleteProject(p.id);
    out(cmd, { removed: p.id }, () => `已删除项目「${p.name}」(${p.id})`);
  }),
);

leaf(
  projectCmd
    .command('bind')
    .description('设置项目技能集(整体替换)')
    .argument('<id|name>', '项目 id 或名称')
    .argument('<skillId|name...>', '一个或多个 skill id 或名称(名称唯一时可用)'),
).action(
  wrap(async (cmd, ref: string, skillRefs: string[]) => {
    const p = await findProject(ref);
    const skills = await resolveSkillRefs(skillRefs);
    const ids = skills.map((s) => s.id);
    await setProjectSkills(p.id, ids);
    out(cmd, { projectId: p.id, skills: ids }, () =>
      `项目「${p.name}」技能集已更新(${ids.length} 个)\n下一步: ssw project apply ${p.id} 使配置生效`,
    );
  }),
);

leaf(
  projectCmd
    .command('bind-mcp')
    .description('设置项目 MCP 服务集(整体替换)')
    .argument('<id|name>', '项目 id 或名称')
    .argument('<mcpName...>', '一个或多个 MCP server 名'),
).action(
  wrap(async (cmd, ref: string, mcpNames: string[]) => {
    const p = await findProject(ref);
    const mcps = await listMcps();
    const missing = mcpNames.filter((n) => !mcps.some((m) => m.name === n));
    if (missing.length) throw new Error(`库中不存在这些 MCP server: ${missing.join(', ')}`);
    await setProjectMcps(p.id, mcpNames);
    out(cmd, { projectId: p.id, mcps: mcpNames }, () => `项目「${p.name}」MCP 服务集已更新(${mcpNames.length} 个)`);
  }),
);

// ---------- mcp ----------
const mcpCmd = program.command('mcp').description('中央库 MCP server 管理');

leaf(mcpCmd.command('list').description('列出库中全部 MCP server')).action(
  wrap(async (cmd) => {
    const mcps = await listMcps();
    out(cmd, mcps, () => {
      if (!mcps.length) return '(库为空,用 ssw mcp add 添加)';
      return mcps
        .map((m) => `${m.name.padEnd(20)} [${m.transport}]  ${m.transport === 'stdio' ? `${m.command} ${(m.args ?? []).join(' ')}` : m.url}${m.description ? `  — ${m.description}` : ''}`)
        .join('\n');
    });
  }),
);

leaf(
  mcpCmd
    .command('add')
    .description('添加/更新 MCP server(--command 与 --url 二选一)')
    .requiredOption('--name <name>', 'server 名(字母/数字/下划线/连字符)')
    .option('--command <cmd>', 'stdio:启动命令(如 npx)')
    .option('--args <args>', 'stdio:参数,逗号分隔(如 -y,@mcp/server)')
    .option('--env <pairs>', 'stdio:环境变量,逗号分隔 KEY=V')
    .option('--cwd <dir>', 'stdio:工作目录(仅部分 agent 支持)')
    .option('--url <url>', 'http/sse:远端端点')
    .option('--transport <type>', '传输类型: stdio|http|sse(缺省按 --command/--url 推断)')
    .option('--header <pairs>', 'http/sse:静态请求头,逗号分隔 KEY=V')
    .option('--desc <text>', '描述'),
).action(
  wrap(async (cmd, opts: {
    name: string; command?: string; args?: string; env?: string; cwd?: string;
    url?: string; transport?: string; header?: string; desc?: string;
  }) => {
    // 解析 KEY=V 逗号串(值里允许再有 =,只按第一个 = 切)
    const parsePairs = (s: string | undefined, flag: string): Record<string, string> | undefined => {
      if (!s) return undefined;
      const out: Record<string, string> = {};
      for (const pair of s.split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new Error(`${flag} 格式错误: "${pair}"(应为 KEY=V)`);
        out[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
      }
      return out;
    };
    if (opts.transport && !['stdio', 'http', 'sse'].includes(opts.transport)) {
      throw new Error('--transport 只能是 stdio|http|sse');
    }
    if (opts.command && opts.url) throw new Error('--command 与 --url 只能二选一');
    if (!opts.command && !opts.url) throw new Error('必须指定 --command(stdio)或 --url(http/sse)之一');
    const entry = await upsertMcp({
      name: opts.name,
      description: opts.desc,
      transport: opts.transport as 'stdio' | 'http' | 'sse' | undefined,
      command: opts.command,
      args: opts.args ? opts.args.split(',').filter(Boolean) : undefined,
      env: parsePairs(opts.env, '--env'),
      cwd: opts.cwd,
      url: opts.url,
      headers: parsePairs(opts.header, '--header'),
    });
    out(cmd, entry, () =>
      `已添加 MCP server: ${entry.name}(${entry.transport})\n下一步: ssw project bind-mcp <项目> ${entry.name} 绑定到项目后 apply 生效`,
    );
  }),
);

leaf(mcpCmd.command('remove').description('从库中删除 MCP server(同时解除各项目的绑定)').argument('<name>', 'server 名')).action(
  wrap(async (cmd, name: string) => {
    const ok = await removeMcp(name);
    if (!ok) throw new Error(`MCP server 不存在: ${name}`);
    out(cmd, { removed: name }, () => `已删除 MCP server: ${name}`);
  }),
);

// ---------- skill ----------
const skillCmd = program.command('skill').description('中央库 skills 管理');

leaf(skillCmd.command('list').description('列出库中全部 skills(带 ★stars 与使用次数热度)')).action(
  wrap(async (cmd) => {
    const skills = await listSkills();
    out(cmd, skills, () => {
      if (!skills.length) return '(库为空,用 ssw skill add/init 添加)';
      return skills
        .map((s) => {
          const hot = `${s.stars ? ` ★${s.stars}` : ''}${s.useCount ? ` 用${s.useCount}次` : ''}`;
          return `${s.id.padEnd(28)} ${s.name.padEnd(16)} [${s.source.type}]${hot}  ${s.description}`;
        })
        .join('\n');
    });
  }),
);

leaf(
  skillCmd
    .command('add')
    .description('安装 skill(--github 与 --local 二选一)')
    .option('--github <uri>', 'GitHub 仓库(owner/repo 或完整 URL)')
    .option('--local <path>', '本地 skill 目录(需含合法 SKILL.md)')
    .option('--subdir <dir>', 'GitHub 仓库内子目录为扫描根(合集仓库常见 skills/,仅配合 --github)'),
).action(
  wrap(async (cmd, opts: { github?: string; local?: string; subdir?: string }) => {
    if (!!opts.github === !!opts.local) throw new Error('必须且只能指定 --github 或 --local 之一');
    if (opts.local && opts.subdir) throw new Error('--subdir 仅支持 --github 来源');
    if (opts.github) {
      const installed = await installFromGithub(opts.github, opts.subdir);
      out(cmd, installed, () =>
        `已从 GitHub 安装 ${installed.length} 个 skill:\n` +
        installed.map((s) => `  ${s.id}  ${s.name}`).join('\n') +
        `\n下一步: ssw project bind <项目> ${installed[0].id} 绑定到项目后 apply 生效`,
      );
    } else {
      const entry = await installFromLocal(opts.local!);
      out(cmd, entry, () =>
        `已从本地安装: ${entry.id}(${entry.name})\n下一步: ssw project bind <项目> ${entry.id} 绑定到项目后 apply 生效`,
      );
    }
  }),
);

leaf(
  skillCmd
    .command('init')
    .description('自建 skill 脚手架(生成合法 SKILL.md;可粘贴/导入现成内容)')
    .option('--name <name>', 'skill 名称(小写字母/数字/连字符;粘贴内容带 frontmatter 时可省略)')
    .option('--desc <description>', 'skill 描述(粘贴内容带 frontmatter 时可省略)')
    .option('--content <text>', 'SKILL.md 内容(粘贴的完整文件或纯正文;与 --file 二选一)')
    .option('--file <path>', '从文件读入 SKILL.md 内容(与 --content 二选一)'),
).action(
  wrap(async (cmd, opts: { name?: string; desc?: string; content?: string; file?: string }) => {
    if (opts.content !== undefined && opts.file !== undefined) {
      throw new Error('--content 与 --file 只能二选一');
    }
    let content = opts.content;
    if (opts.file !== undefined) {
      try {
        content = await fs.readFile(path.resolve(opts.file), 'utf8');
      } catch (err) {
        throw new Error(`读取 --file 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (content === undefined && (!opts.name || !opts.desc)) {
      throw new Error('必须指定 --name 与 --desc(或用 --content/--file 提供带 frontmatter 的 SKILL.md)');
    }
    const entry = await initSkill(opts.name ?? '', opts.desc ?? '', content);
    out(cmd, entry, () =>
      `已创建 skill 脚手架: ${entry.id}(目录在库中,可继续编辑)\n下一步: ssw project bind <项目> ${entry.id} 绑定到项目后 apply 生效`,
    );
  }),
);

leaf(skillCmd.command('remove').description('从库中卸载 skill(同时解除各项目的绑定)').argument('<id|name>', 'skill id 或名称(名称唯一时可用)')).action(
  wrap(async (cmd, ref: string) => {
    const s = await findSkill(ref);
    const r = await uninstall(s.id);
    if (!r.removed) throw new Error(`skill 不存在: ${s.id}`);
    out(cmd, r, () =>
      `已卸载: ${s.id}` +
      (r.alsoRemoved.length ? `\n连带移除同仓库条目: ${r.alsoRemoved.join(', ')}` : ''),
    );
  }),
);

leaf(
  skillCmd
    .command('update')
    .description('更新 skill(省略参数则更新全部 github 来源;--check 只检查不更新)')
    .argument('[id|name]', 'skill id 或名称(名称唯一时可用)')
    .option('--check', '只检查更新(git fetch 比对各仓库上游),不执行更新'),
).action(
  wrap(async (cmd, ref: string | undefined, opts: { check?: boolean }) => {
    // --check:定时查询的手动版——只报告哪些仓库落后远程,不改动库
    if (opts.check) {
      if (ref) throw new Error('--check 与指定 skill 二选一(检查总是覆盖全部 github 仓库)');
      const r = await checkLibraryUpdates();
      out(cmd, r, () => {
        if (!r.ok) return `✗ ${r.message}`;
        if (!r.updates.length) return '(库中没有 github 来源的 skill)';
        const lines: string[] = [];
        const updatable = r.updates.filter((u) => u.behind > 0 && !u.error);
        for (const u of r.updates) {
          if (u.error) lines.push(`✗ ${u.repoId}  检查失败: ${u.error}`);
          else if (u.behind > 0) lines.push(`↑ ${u.repoId}  落后 ${u.behind} 个提交(${u.skillNames.join(', ')})`);
        }
        lines.push(
          updatable.length
            ? `共 ${updatable.length} 个仓库可更新;一键更新全部: ssw skill update`
            : `✓ 全部已是最新(${r.updates.length} 个 github 仓库)`,
        );
        return lines.join('\n');
      });
      // 有可更新项时退出码非零,方便脚本判断"需要更新"(结果明细仍打 stdout)
      if (r.ok && r.updates.some((u) => u.behind > 0 && !u.error)) process.exitCode = 1;
      return;
    }
    if (ref) {
      const s = await findSkill(ref);
      const entry = await updateSkill(s.id);
      out(cmd, entry, () => `已更新: ${entry.id}`);
      return;
    }
    const registry = await readRegistry();
    const targets = registry.filter((s) => s.source.type === 'github');
    const results: { id: string; ok: boolean; message: string }[] = [];
    for (const s of targets) {
      try {
        await updateSkill(s.id);
        results.push({ id: s.id, ok: true, message: 'ok' });
      } catch (err) {
        results.push({ id: s.id, ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
    out(cmd, results, () => {
      if (!targets.length) return '(没有 github 来源的 skill 需要更新)';
      return results.map((r) => `${r.ok ? '✓' : '✗'} ${r.id}${r.ok ? '' : `  ${r.message}`}`).join('\n');
    });
  }),
);

leaf(
  skillCmd
    .command('adopt')
    .description('收养 agent 目录里已有的 skills 进中央库(逆向于 apply);--all 一次扫描所有 agent')
    .option('--agent <id>', 'agent id(见 ssw agents)')
    .option('--all', '收养所有 agent(与 --agent 二选一;同名跨 agent 去重,同目录只扫一次)')
    .option('--user', '收养用户级(全局)skills 目录,缺省为项目级')
    .option('--path <path>', '项目根目录(项目级作用域用;缺省取当前工作目录)'),
).action(
  wrap(async (cmd, opts: { agent?: string; all?: boolean; user?: boolean; path?: string }) => {
    if (opts.all && opts.agent) throw new Error('--all 与 --agent 二选一');
    if (!opts.all && !opts.agent) throw new Error('请指定 --agent <id>,或 --all 一次收养所有 agent');
    const scope = opts.user ? ('user' as const) : ('project' as const);
    const projectPath = path.resolve(opts.path ?? '.');
    if (opts.all) {
      const r = await adoptFromAllAgents({ scope, projectPath });
      out(cmd, r, () => {
        const lines: string[] = [];
        for (const s of r.scanned) {
          lines.push(`【${s.displayName}】${s.dir}`);
          const sub = [
            ...s.result.adopted.map((x) => `  ✓ ${x.id}  已收养`),
            ...s.result.skipped.map((n) => `  - ${n}  已在库中,跳过`),
            ...s.result.invalid.map((i) => `  ✗ ${i.dir}  ${i.reason}`),
          ];
          lines.push(...(sub.length ? sub : ['  (没有可收养的 skill)']));
        }
        lines.push(
          `汇总:新收 ${r.adopted.length},已在库 ${r.skipped.length},非法 ${r.invalid.length}` +
          `;跳过 agent ${r.skippedAgents.length} 个(未安装/无目录)`,
        );
        return lines.join('\n');
      });
      return;
    }
    const r = await adoptFromAgent(opts.agent!, { scope, projectPath });
    out(cmd, r, () => {
      const lines = [
        ...r.adopted.map((s) => `✓ ${s.id}  已收养`),
        ...r.skipped.map((n) => `- ${n}  已在库中,跳过`),
        ...r.invalid.map((i) => `✗ ${i.dir}  ${i.reason}`),
      ];
      return lines.length ? lines.join('\n') : '(该目录下没有可收养的 skill)';
    });
  }),
);

// ---------- 迁移码 ----------
leaf(skillCmd.command('export').description('导出迁移码(仅 github 来源;新环境 ssw skill import 粘贴即可还原)')).action(
  wrap(async (cmd) => {
    const code = exportSkillsCode(await listSkills());
    out(cmd, { code, repos: parseSkillsCode(code) }, () =>
      parseSkillsCode(code).length ? code : '(库中没有 github 来源的 skill)');
  }),
);

leaf(
  skillCmd.command('import').description('粘贴迁移码,批量安装其中的 github skills').argument('<code>', '迁移码(ssw1:...)'),
).action(
  wrap(async (cmd, code: string) => {
    const r = await importSkillsCode(code);
    out(cmd, r, () => {
      const lines = [
        ...r.installed.map((repo) => `✓ ${repo}  已安装`),
        ...r.skipped.map((repo) => `- ${repo}  已在库中,跳过`),
        ...r.failed.map((f) => `✗ ${f.repo}  ${f.message}`),
      ];
      return lines.length ? lines.join('\n') : '(迁移码为空)';
    });
    // 有失败项时退出码非零,方便脚本判断(结果明细仍打 stdout)
    if (r.failed.length) process.exitCode = 1;
  }),
);

// ---------- recommend ----------
leaf(
  program
    .command('recommend')
    .description('检测技术栈 + 关键词,输出 GitHub 高 star 推荐(按 star 降序)')
    .option('--path <path>', '项目根目录(缺省取当前工作目录,用于技术栈检测)')
    .option('--keywords <words>', '额外关键词,逗号分隔'),
).action(
  wrap(async (cmd, opts: { path?: string; keywords?: string }) => {
    const abs = path.resolve(opts.path ?? '.');
    const keywords = (opts.keywords ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // 项目名参数兼作关键词来源:目录名 + 显式关键词(core 内部会再分词)
    const nameSeed = [path.basename(abs), ...keywords].join(' ');
    const result = await recommendForProject(abs, nameSeed);
    out(cmd, result, () => {
      const lines: string[] = [];
      if (result.message) lines.push(`(${result.message})`);
      if (!result.items.length && !result.message) lines.push('(无推荐结果)');
      for (const r of result.items) {
        lines.push(`★ ${String(r.stars).padStart(6)}  ${r.name}  (${r.repo})`);
        if (r.description) lines.push(`          ${r.description}`);
        lines.push(`          推荐理由: ${r.reason}`);
        lines.push(`          ${r.url}`);
      }
      return lines.join('\n');
    });
  }),
);

// ---------- catalog 推荐库 ----------
const catalogCmd = leaf(
  program
    .command('catalog')
    .description('推荐库:内置精选高 star skills 与常用 MCP server 目录,按 star 降序')
    .option('--category <id>', '只看某个分类(id 见 ssw catalog categories)')
    .option('--kind <kind>', '只看某类条目: skill|mcp(skills 与 MCP 分流浏览/安装)')
    .option('--q <keyword>', '关键词过滤(名称/描述/仓库);配合 --github/--ai 即联网搜索')
    .option('--github', '联网搜索 GitHub 的 agent-skills 仓库(配合 --q;结果带仓库链接)')
    .option('--ai', '先用已配置的 AI 把 --q 的需求提炼成英文关键词再联网搜索(蕴含 --github)'),
).action(
  wrap(async (cmd, opts: { category?: string; kind?: string; q?: string; github?: boolean; ai?: boolean }) => {
    if (opts.kind && opts.kind !== 'skill' && opts.kind !== 'mcp') {
      throw new Error('--kind 只能是 skill 或 mcp');
    }
    const wantGithub = !!(opts.github || opts.ai);
    if (wantGithub && !opts.q?.trim()) throw new Error('--github/--ai 需配合 --q(搜索词或需求描述)');
    const kind = opts.kind as 'skill' | 'mcp' | undefined;
    const items = await listCatalogWithInstalled({ category: opts.category, kind, query: opts.q });
    const cats = listCatalogCategories();
    // 联网搜索与本地过滤互不阻塞:本地结果照常列出,GitHub 结果追加在后(降级只影响本段)
    const github = wantGithub ? await searchCatalogGithub(opts.q!.trim(), { ai: !!opts.ai }) : null;
    out(cmd, { categories: cats, items, ...(github ? { github } : {}) }, () => {
      const catName = (id: string) => cats.find((c) => c.id === id)?.name ?? id;
      const lines: string[] = [];
      for (const e of items) {
        // MCP 条目可能无公开仓库星数(stars 0),不显示 ★;状态文案区分"已安装/已添加"
        const starTxt = e.stars > 0 ? `★ ${String(e.stars).padStart(6)}` : '         ';
        const kindTag = e.kind === 'mcp' ? '[MCP]' : '[skills]';
        const stateTxt = e.installed ? (e.kind === 'mcp' ? '  (已添加)' : `  (已安装 ${e.installedCount})`) : '';
        lines.push(`${starTxt}  ${e.name}  ${kindTag}[${catName(e.category)}]  ${e.id}${stateTxt}`);
        lines.push(`          ${e.description}`);
      }
      if (!items.length) lines.push('(本地推荐库无匹配条目)');
      if (github) {
        lines.push('');
        const kwTxt = github.keywords.length ? github.keywords.join(', ') : '-';
        lines.push(
          github.ai
            ? `GitHub 联网搜索(AI 提炼关键词: ${kwTxt}${github.model ? ` · ${github.model}` : ''}):`
            : `GitHub 联网搜索(关键词: ${kwTxt}):`,
        );
        if (github.message) lines.push(`  (${github.message})`);
        for (const g of github.items) {
          lines.push(`  ★ ${String(g.stars).padStart(6)}  ${g.repo}${g.installed ? `  (已安装 ${g.installedCount})` : ''}`);
          if (g.description) lines.push(`            ${g.description}`);
          lines.push(`            ${g.url}`);
        }
        lines.push('安装: ssw catalog install <owner/repo>(或 ssw skill add --github <owner/repo>)');
      } else {
        lines.push(`共 ${items.length} 条;分类清单: ssw catalog categories;只看一类: --kind skill|mcp;安装: ssw catalog install <owner/repo|MCP名>`);
        lines.push('没找到?联网搜索: ssw catalog --q <搜索词或需求> --github(或 --ai 让 AI 提炼关键词)');
      }
      return lines.join('\n');
    });
  }),
);

// 分类管理:列出全部分类及条目统计(--category 的 id 从这里查)
leaf(catalogCmd.command('categories').description('列出推荐库分类及每类条目数(skill / MCP 细分)')).action(
  wrap(async (cmd) => {
    const cats = listCatalogCategories();
    const total = cats.reduce((n, c) => n + c.count, 0);
    out(cmd, { total, categories: cats }, () => {
      const lines = cats.map(
        (c) => `${c.id.padEnd(14)} ${c.name.padEnd(10)} ${String(c.count).padStart(3)} 条(skill ${c.skills} / MCP ${c.mcps})`,
      );
      lines.push(`共 ${cats.length} 个分类、${total} 条;按分类看: ssw catalog --category <id>`);
      return lines.join('\n');
    });
  }),
);

leaf(
  catalogCmd
    .command('install')
    .description('安装推荐库条目:skill 条目整仓安装(仓库内全部 skill 登记);MCP 条目写入中央注册表')
    .argument('<id>', '推荐库条目 id(owner/repo 或 MCP server 名)'),
).action(
  wrap(async (cmd, repo: string) => {
    const hit = CATALOG.find((e) => e.id.toLowerCase() === repo.toLowerCase());
    if (hit?.kind === 'mcp') {
      // MCP 条目:安装即把载荷写入中央注册表;env/headers 里的密钥是占位符,提示用户替换
      const entry = await upsertMcp({ name: hit.id, description: hit.description, ...hit.mcp });
      out(cmd, { inCatalog: true, added: entry }, () =>
        `已添加 MCP server: ${entry.name}(${entry.transport})\n` +
        '提示:若条目带密钥占位符(YOUR_*),请用 ssw mcp add 同名覆盖或在 GUI 的 MCP 页修改',
      );
      return;
    }
    // 命中目录则用条目的规范 URL 与 subdir(合集仓库的 skills 子目录)安装
    const installed = await installFromGithub(hit ? hit.url : repo, hit?.subdir);
    out(cmd, { inCatalog: !!hit, installed }, () =>
      (hit ? '' : `提示: ${repo} 不在推荐库中,已按普通 GitHub 仓库处理\n`) +
      `已安装 ${installed.length} 个 skill:\n` +
      installed.map((s) => `  ${s.id}  ${s.name}`).join('\n'),
    );
  }),
);

// ---------- global 全局(用户级)共享 ----------
const globalCmd = program.command('global').description('全局共享:一次配置,物化到各 agent 的用户级 skills 目录,所有项目共享');

leaf(globalCmd.command('show').description('查看全局共享配置')).action(
  wrap(async (cmd) => {
    const g = await readGlobal();
    const registry = await readRegistry();
    const skills = registry.filter((s) => g.skills.includes(s.id));
    out(cmd, { ...g, skillDetails: skills }, () => {
      const lines = [
        `目标 agents: ${g.agents.join(', ') || '(未设置,用 ssw global agents 设置)'}`,
        `apply 模式: ${g.applyMode}`,
        `上次 apply: ${fmtTime(g.lastAppliedAt)}`,
        `技能集(${skills.length}):`,
        ...skills.map((s) => `  ${s.id.padEnd(24)} ${s.name} - ${s.description}`),
      ];
      return lines.join('\n');
    });
  }),
);

leaf(
  globalCmd.command('bind').description('设置全局技能集(整体替换)').argument('<skillId|name...>', '一个或多个 skill id 或名称(名称唯一时可用)'),
).action(
  wrap(async (cmd, skillRefs: string[]) => {
    const skills = await resolveSkillRefs(skillRefs);
    const ids = skills.map((s) => s.id);
    await updateGlobal({ skills: ids });
    out(cmd, { skills: ids }, () => `全局技能集已更新(${ids.length} 个)\n下一步: ssw global apply 使配置生效`);
  }),
);

leaf(
  globalCmd
    .command('agents')
    .description('设置全局目标 agents(整体替换)')
    .argument('<id...>', '一个或多个 agent id')
    .option('--mode <mode>', 'apply 模式: symlink|copy'),
).action(
  wrap(async (cmd, ids: string[], opts: { mode?: string }) => {
    for (const id of ids) {
      if (!getAdapter(id)) throw new Error(`未知 agent: ${id}(可用: ${adapters.map((a) => a.id).join(', ')})`);
    }
    if (opts.mode && !['symlink', 'copy'].includes(opts.mode)) throw new Error('--mode 只能是 symlink 或 copy');
    await updateGlobal({ agents: ids, ...(opts.mode ? { applyMode: opts.mode as 'symlink' | 'copy' } : {}) });
    out(cmd, { agents: ids }, () => `全局目标 agents 已更新: ${ids.join(', ')}`);
  }),
);

leaf(globalCmd.command('apply').description('把全局技能集物化到各 agent 的用户级 skills 目录')).action(
  wrap(async (cmd) => {
    const result = await applyGlobal();
    out(cmd, result, () => {
      const lines = [`已全局应用 ${result.applied.length} 项`];
      for (const a of result.applied) lines.push(`  [${a.agentId}] ${a.skillName} -> ${a.target} (${a.mode})`);
      for (const w of result.warnings) lines.push(`  警告: ${w}`);
      return lines.join('\n');
    });
  }),
);

leaf(globalCmd.command('unapply').description('移除全局共享的物化结果')).action(
  wrap(async (cmd) => {
    const result = await unapplyGlobal();
    out(cmd, result, () => `已移除 ${result.removed.length} 项(全局共享)`);
  }),
);

leaf(globalCmd.command('rollback').description('回滚最近一次全局 apply 快照')).action(
  wrap(async (cmd) => {
    const result = await rollbackGlobal();
    if (!result.restored) throw new Error(result.detail);
    out(cmd, result, () => result.detail);
  }),
);

// ---------- profile 配置库导出/导入 ----------
const profileCmd = program.command('profile').description('配置库整体导出/导入(跨机器/跨平台共享,含 local 技能与项目档案)');

leaf(
  profileCmd.command('export').description('导出完整配置库为 JSON(缺省打 stdout)').option('--file <path>', '写入文件而不是 stdout'),
).action(
  wrap(async (cmd, opts: { file?: string }) => {
    const { bundle, warnings } = await exportProfile();
    if (opts.file) {
      await fs.writeFile(path.resolve(opts.file), JSON.stringify(bundle, null, 2), 'utf8');
      out(cmd, { file: opts.file, warnings }, () =>
        `已导出配置库到 ${opts.file}(skills ${bundle.skills.length}、MCP ${bundle.mcps.length}、项目 ${bundle.projects.projects.length})` +
        (warnings.length ? `\n${warnings.map((w) => `警告: ${w}`).join('\n')}` : ''),
      );
    } else {
      // 走 stdout 时警告打 stderr,保证 stdout 是合法 JSON(管道友好)
      for (const w of warnings) console.error(`警告: ${w}`);
      console.log(JSON.stringify(bundle, null, 2));
    }
  }),
);

leaf(
  profileCmd.command('import').description('从 JSON 文件导入配置库').argument('<file>', 'profile JSON 文件路径'),
).action(
  wrap(async (cmd, file: string) => {
    let bundle: unknown;
    try {
      bundle = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
    } catch (err) {
      throw new Error(`读取 profile 文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const r = await importProfile(bundle);
    out(cmd, r, () => {
      const lines = [
        ...r.installedRepos.map((repo) => `✓ ${repo}  已安装`),
        ...r.skippedRepos.map((repo) => `- ${repo}  已在库中,跳过`),
        ...r.failed.map((f) => `✗ ${f.repo}  ${f.message}`),
        `local 技能还原 ${r.localRestored.length} 个;项目新增 ${r.projectsAdded} 个(同名跳过 ${r.projectsSkipped});MCP 新增 ${r.mcpsAdded} 个${r.globalImported ? ';全局档案已导入' : ''}`,
        ...r.warnings.map((w) => `警告: ${w}`),
      ];
      return lines.join('\n');
    });
    // 有失败项时退出码非零,方便脚本判断(同 skill import 约定)
    if (r.failed.length) process.exitCode = 1;
  }),
);

// ---------- AI 推荐(模型读技能库 + 开发需求;配置存 ai.json)----------
const aiCmd = program.command('ai').description('AI 技能推荐:配置模型(baseUrl/apiKey/model,支持中转站),按开发需求从库中推荐技能');

leaf(
  aiCmd
    .command('config')
    .description('查看/设置 AI 配置(不带选项 = 查看;--preset 一键套用预设端点与模型)')
    .option('--preset <id>', '预设:kimi|deepseek|openai|openrouter(套用其 baseUrl 与首个模型)')
    .option('--base-url <url>', 'OpenAI 兼容端点(官方或中转站地址)')
    .option('--model <name>', '模型名')
    .option('--api-key <key>', 'API Key(明文存本机数据目录;传空串清除)'),
).action(
  wrap(async (cmd, opts: { preset?: string; baseUrl?: string; model?: string; apiKey?: string }) => {
    const hasSet = opts.preset !== undefined || opts.baseUrl !== undefined || opts.model !== undefined || opts.apiKey !== undefined;
    if (hasSet) {
      const patch: { baseUrl?: string; model?: string; apiKey?: string } = {};
      if (opts.preset !== undefined) {
        const preset = AI_PRESETS.find((x) => x.id === opts.preset);
        if (!preset) throw new Error(`未知预设: ${opts.preset}(可用: ${AI_PRESETS.map((x) => x.id).join(', ')})`);
        patch.baseUrl = preset.baseUrl;
        patch.model = preset.models[0];
      }
      // 显式参数覆盖预设(顺序:先套预设,再叠显式值)
      if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
      if (opts.model !== undefined) patch.model = opts.model;
      if (opts.apiKey !== undefined) patch.apiKey = opts.apiKey;
      const cfg = await updateAiConfig(patch);
      out(cmd, toPublicConfig(cfg), () => `AI 配置已更新: ${cfg.baseUrl} · ${cfg.model}${cfg.apiKey ? ' · API Key 已设置' : ''}`);
      return;
    }
    const cfg = await readAiConfig();
    out(cmd, { ...toPublicConfig(cfg), presets: AI_PRESETS }, () => {
      const lines = [
        `baseUrl: ${cfg.baseUrl}`,
        `model:   ${cfg.model}`,
        `apiKey:  ${toPublicConfig(cfg).apiKeyMask || '(未设置)'}`,
        '',
        '预设(--preset 一键套用,再 --api-key 填密钥):',
        ...AI_PRESETS.map((p) => `  ${p.id.padEnd(10)} ${p.label.padEnd(18)} ${p.baseUrl}  模型: ${p.models.join(', ')}`),
        '中转站: --base-url <中转站地址> --model <模型名> --api-key <key>',
      ];
      return lines.join('\n');
    });
  }),
);

leaf(aiCmd.command('test').description('测试 AI 连接(走与推荐相同的最小 chat 请求)')).action(
  wrap(async (cmd) => {
    const r = await testAiConnection();
    out(cmd, r, () => `${r.ok ? '✓' : '✗'} ${r.message}`);
    if (!r.ok) process.exitCode = 1;
  }),
);

leaf(
  aiCmd
    .command('recommend')
    .description('AI 按开发需求从技能库推荐技能;--bind 把推荐并入指定项目的技能集')
    .argument('<requirement>', '开发需求(一两句话,如 "React + TS 的后台管理系统")')
    .option('--bind <id|name>', '把推荐结果并入该项目技能集(缺省只看不绑)'),
).action(
  wrap(async (cmd, requirement: string, opts: { bind?: string }) => {
    const r = await aiRecommendSkills({ requirement });
    let bound: string[] = [];
    if (opts.bind && r.items.length) {
      const p = await findProject(opts.bind);
      bound = [...new Set([...p.skills, ...r.items.map((s) => s.id)])];
      await setProjectSkills(p.id, bound);
    }
    out(cmd, { ...r, bound }, () => {
      const lines: string[] = [];
      if (r.message) lines.push(`(${r.message})`);
      for (const item of r.items) {
        const hot = `${item.stars ? ` ★${item.stars}` : ''}${item.useCount ? ` 用${item.useCount}次` : ''}`;
        lines.push(`✓ ${item.id}  ${item.name}${hot}`);
        if (item.reason) lines.push(`    推荐理由: ${item.reason}`);
      }
      if (r.github.length) {
        lines.push('GitHub 联网推荐(未入库,安装: ssw skill add --github <owner/repo>):');
        for (const g of r.github) lines.push(`  ★${g.stars}  ${g.repo}  ${g.description}${g.description ? '  ' : ''}(关键词: ${g.keyword})`);
      } else if (r.githubMessage) {
        lines.push(`(GitHub 联网推荐: ${r.githubMessage})`);
      }
      if (bound.length) lines.push(`已并入项目技能集(现共 ${bound.length} 个);apply 生效: ssw project apply ${opts.bind}`);
      else if (r.items.length && !opts.bind) lines.push('绑定到项目: ssw ai recommend "<需求>" --bind <id|name>');
      return lines.join('\n');
    });
    // 推荐通道本身失败(降级 message 且本地/联网都无结果)时退出码非零,便于脚本判断
    if (!r.items.length && !r.github.length) process.exitCode = 1;
  }),
);

// ---------- doctor 环境自检 ----------
leaf(
  program.command('doctor').description('环境自检:数据目录/git/agent 检测/数据文件健康度,附修复建议'),
).action(
  wrap(async (cmd) => {
    const report = await runDoctor();
    out(cmd, { version: VERSION, ...report }, () => {
      const icon = { ok: '✓', warn: '⚠', error: '✗' } as const;
      const lines = [
        `Skills SwitchTool v${VERSION} 环境自检`,
        ...report.checks.map((c) => `${icon[c.level]} ${c.label}${c.hint ? `\n    建议: ${c.hint}` : ''}`),
        `统计: skills ${report.stats.skills} / MCP ${report.stats.mcps} / 项目 ${report.stats.projects}` +
          (report.stats.activeProject ? `(当前激活: ${report.stats.activeProject})` : ''),
      ];
      return lines.join('\n');
    });
    // 存在 error 级问题时退出码非零,便于脚本/CI 判断(warn 不算失败)
    if (!report.ok) process.exitCode = 1;
  }),
);

// ---------- update 软件更新 ----------
leaf(
  program
    .command('update')
    .description('软件更新:对照 GitHub Releases 检查新版本(不带选项 = 立即检查)')
    .option('--download', '下载匹配当前平台的安装包到数据目录 downloads/')
    .option('--open', '用浏览器打开最新 release 发布页')
    .option('--auto-check <on|off>', '启动时自动检查更新(桌面 App;不带其他选项时只保存配置)')
    .option('--auto-download <on|off>', '发现新版本时自动下载安装包(不带其他选项时只保存配置)')
    .option('--skills-check <on|off>', '定时检查技能库(github 来源 skills)更新,默认每 6 小时'),
).action(
  wrap(
    async (
      cmd,
      opts: { download?: boolean; open?: boolean; autoCheck?: string; autoDownload?: string; skillsCheck?: string },
    ) => {
      // 配置开关:纯本地读写,不发网络请求
      if (opts.autoCheck !== undefined || opts.autoDownload !== undefined || opts.skillsCheck !== undefined) {
        const parseBool = (v: string | undefined, flag: string): boolean | undefined => {
          if (v === undefined) return undefined;
          if (v === 'on') return true;
          if (v === 'off') return false;
          throw new Error(`${flag} 只能是 on 或 off`);
        };
        const cfg = await saveUpdateConfig({
          autoCheck: parseBool(opts.autoCheck, '--auto-check'),
          autoDownload: parseBool(opts.autoDownload, '--auto-download'),
          skillsAutoCheck: parseBool(opts.skillsCheck, '--skills-check'),
        });
        out(cmd, cfg, () =>
          `更新配置已保存:自动检查 ${cfg.autoCheck ? '开' : '关'} · 自动下载 ${cfg.autoDownload ? '开' : '关'} · 定时检查技能库 ${cfg.skillsAutoCheck ? `开(每 ${cfg.skillsCheckIntervalHours}h)` : '关'}`,
        );
        return;
      }
      // 打开发布页:不强制刷新,缓存/新查任一拿到 releaseUrl 即可
      if (opts.open) {
        const r = await checkForUpdate();
        const url =
          (r.ok && r.releaseUrl) || 'https://github.com/Chongrong1234/Skills_switchtool/releases';
        await openExternal(url);
        out(cmd, { opened: url }, () => `已在浏览器打开: ${url}`);
        return;
      }
      const r = await checkForUpdate({ force: true });
      if (opts.download) {
        if (!r.ok) throw new Error(r.message ?? '检查更新失败');
        if (!r.hasUpdate) {
          out(cmd, r, () => `✓ 已是最新版本(v${r.current};最新 release: ${r.tag}),无需下载`);
          return;
        }
        if (!r.asset) {
          throw new Error(
            `发现新版本 v${r.latest},但没有匹配当前平台的安装包;请到发布页手动下载: ${r.releaseUrl}`,
          );
        }
        // TTY 下 500ms 轮询下载进度写 stderr(不污染 --json 的 stdout,与 git 进度条同约定)
        const timer = process.stderr.isTTY
          ? setInterval(() => {
              const job = getUpdateDownload();
              if (job) process.stderr.write(`\r\x1b[K下载中: ${job.text}`);
            }, 500)
          : null;
        try {
          const { file } = await downloadUpdate(r.asset);
          const installHint =
            process.platform === 'win32'
              ? '运行该安装程序覆盖安装即可'
              : process.platform === 'darwin'
                ? '打开 dmg 把 App 拖入 Applications 替换旧版'
                : '直接替换现有 AppImage 运行(可执行位已设置)';
          out(cmd, { file, version: r.latest }, () => `已下载 v${r.latest}: ${file}\n安装: ${installHint}`);
        } finally {
          if (timer) {
            clearInterval(timer);
            process.stderr.write('\n');
          }
        }
        return;
      }
      out(cmd, r, () => {
        if (!r.ok) return `✗ ${r.message}`;
        if (!r.hasUpdate) return `✓ 已是最新版本(v${r.current};最新 release: ${r.tag})`;
        const lines = [
          `发现新版本: v${r.latest}(当前 v${r.current},发布于 ${fmtTime(r.publishedAt)})`,
          `发布页: ${r.releaseUrl}`,
        ];
        if (r.asset) {
          lines.push(
            `安装包: ${r.asset.name}(${(r.asset.size / 1048576).toFixed(1)} MB)`,
            '下载: ssw update --download;浏览器打开发布页: ssw update --open',
          );
        } else {
          lines.push('(没有匹配当前平台的安装包,请到发布页手动下载)');
        }
        return lines.join('\n');
      });
      // 检查失败(降级 message)时退出码非零,便于脚本判断
      if (!r.ok) process.exitCode = 1;
    },
  ),
);

// 不带任何参数启动:TTY 下进入交互式终端面板,非 TTY(管道/脚本)打印帮助
if (process.argv.length <= 2) {
  if (process.stdin.isTTY) {
    try {
      const { startTui } = await import('./tui.js');
      await startTui();
    } catch (err) {
      fail(err);
    }
  } else {
    program.outputHelp();
  }
} else {
  await program.parseAsync(process.argv);
}
