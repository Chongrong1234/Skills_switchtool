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
import { CATALOG, listCatalogCategories, listCatalogWithInstalled } from './core/catalog.js';
import { exportSkillsCode, importSkillsCode, parseSkillsCode } from './core/migrate.js';
import { rollback } from './core/snapshot.js';
import type { Project } from './core/types.js';
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

/** ref 省略时用当前激活项目 */
async function resolveProject(ref: string | undefined): Promise<Project> {
  if (ref) return findProject(ref);
  const { activeProjectId } = await listProjects();
  if (!activeProjectId) throw new Error('未指定项目且没有当前激活项目');
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
    .requiredOption('--agents <ids>', '目标 agents,逗号分隔(如 claude-code,kimi-code)')
    .option('--mode <mode>', 'apply 模式: symlink|copy', 'symlink'),
).action(
  wrap(async (cmd, opts: { name: string; path?: string; agents: string; mode: string }) => {
    if (!['symlink', 'copy'].includes(opts.mode)) {
      throw new Error('--mode 只能是 symlink 或 copy');
    }
    const agentIds = opts.agents.split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of agentIds) {
      if (!getAdapter(id)) throw new Error(`未知 agent: ${id}(可用: ${adapters.map((a) => a.id).join(', ')})`);
    }
    // --path 缺省取当前工作目录:在项目根里跑命令时无需手填
    const p = await createProject({ name: opts.name, path: path.resolve(opts.path ?? '.'), agents: agentIds, applyMode: opts.mode as 'symlink' | 'copy' });
    out(cmd, p, () => `已创建项目 ${p.name}(${p.id})`);
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
    .argument('<skillId...>', '一个或多个 skill id'),
).action(
  wrap(async (cmd, ref: string, skillIds: string[]) => {
    const p = await findProject(ref);
    const registry = await readRegistry();
    const missing = skillIds.filter((id) => !registry.some((s) => s.id === id));
    if (missing.length) throw new Error(`库中不存在这些 skill: ${missing.join(', ')}`);
    await setProjectSkills(p.id, skillIds);
    out(cmd, { projectId: p.id, skills: skillIds }, () => `项目「${p.name}」技能集已更新(${skillIds.length} 个)`);
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
    out(cmd, entry, () => `已添加 MCP server: ${entry.name}(${entry.transport})`);
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

leaf(skillCmd.command('list').description('列出库中全部 skills')).action(
  wrap(async (cmd) => {
    const skills = await listSkills();
    out(cmd, skills, () => {
      if (!skills.length) return '(库为空,用 ssw skill add/init 添加)';
      return skills
        .map((s) => `${s.id.padEnd(28)} ${s.name.padEnd(16)} [${s.source.type}]  ${s.description}`)
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
      out(cmd, installed, () => `已从 GitHub 安装 ${installed.length} 个 skill:\n` + installed.map((s) => `  ${s.id}  ${s.name}`).join('\n'));
    } else {
      const entry = await installFromLocal(opts.local!);
      out(cmd, entry, () => `已从本地安装: ${entry.id}(${entry.name})`);
    }
  }),
);

leaf(
  skillCmd
    .command('init')
    .description('自建 skill 脚手架(生成合法 SKILL.md)')
    .requiredOption('--name <name>', 'skill 名称(小写字母/数字/连字符)')
    .requiredOption('--desc <description>', 'skill 描述'),
).action(
  wrap(async (cmd, opts: { name: string; desc: string }) => {
    const entry = await initSkill(opts.name, opts.desc);
    out(cmd, entry, () => `已创建 skill 脚手架: ${entry.id}(目录在库中,可继续编辑)`);
  }),
);

leaf(skillCmd.command('remove').description('从库中卸载 skill(同时解除各项目的绑定)').argument('<id>', 'skill id')).action(
  wrap(async (cmd, id: string) => {
    const r = await uninstall(id);
    if (!r.removed) throw new Error(`skill 不存在: ${id}`);
    out(cmd, r, () =>
      `已卸载: ${id}` +
      (r.alsoRemoved.length ? `\n连带移除同仓库条目: ${r.alsoRemoved.join(', ')}` : ''),
    );
  }),
);

leaf(skillCmd.command('update').description('更新 skill(省略 id 则更新全部 github 来源)').argument('[id]', 'skill id')).action(
  wrap(async (cmd, id?: string) => {
    if (id) {
      const entry = await updateSkill(id);
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
    .description('收养 agent 目录里已有的 skills 进中央库(逆向于 apply)')
    .requiredOption('--agent <id>', 'agent id(见 ssw agents)')
    .option('--user', '收养用户级(全局)skills 目录,缺省为项目级')
    .option('--path <path>', '项目根目录(项目级作用域用;缺省取当前工作目录)'),
).action(
  wrap(async (cmd, opts: { agent: string; user?: boolean; path?: string }) => {
    const r = await adoptFromAgent(opts.agent, {
      scope: opts.user ? 'user' : 'project',
      projectPath: path.resolve(opts.path ?? '.'),
    });
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
    .description('推荐库:内置精选高 star skills 目录,按 star 降序')
    .option('--category <id>', '只看某个分类(id 见 ssw catalog categories)')
    .option('--q <keyword>', '关键词过滤(名称/描述/仓库)'),
).action(
  wrap(async (cmd, opts: { category?: string; q?: string }) => {
    const items = await listCatalogWithInstalled({ category: opts.category, query: opts.q });
    const cats = listCatalogCategories();
    out(cmd, { categories: cats, items }, () => {
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
      if (!items.length) lines.push('(无匹配条目)');
      lines.push(`共 ${items.length} 条;分类清单: ssw catalog categories;安装: ssw catalog install <owner/repo|MCP名>`);
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
  globalCmd.command('bind').description('设置全局技能集(整体替换)').argument('<skillId...>', '一个或多个 skill id'),
).action(
  wrap(async (cmd, skillIds: string[]) => {
    const registry = await readRegistry();
    const missing = skillIds.filter((id) => !registry.some((s) => s.id === id));
    if (missing.length) throw new Error(`库中不存在这些 skill: ${missing.join(', ')}`);
    await updateGlobal({ skills: skillIds });
    out(cmd, { skills: skillIds }, () => `全局技能集已更新(${skillIds.length} 个)`);
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
