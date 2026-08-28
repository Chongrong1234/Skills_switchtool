#!/usr/bin/env node
/**
 * ssw —— Skills SwitchTool 命令行版(服务器/无 GUI 环境用)。
 * 纯命令行非交互;全部子命令映射 core 能力;全局 --json 输出便于脚本化。
 * 错误输出到 stderr 且退出码非零;成功输出到 stdout。
 */
import { Command } from 'commander';
import path from 'node:path';
import { adapters, getAdapter } from './adapters/index.js';
import { applyProject, unapplyProject } from './core/apply.js';
import {
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
  setProjectSkills,
} from './core/projects.js';
import { recommendForProject } from './core/recommend.js';
import { rollback } from './core/snapshot.js';
import type { Project } from './core/types.js';
import { readRegistry } from './core/registry.js';
import { startServer, serverPort } from './serve.js';

const program = new Command();
program
  .name('ssw')
  .description('Skills SwitchTool —— 项目中心化的 Agent Skills 管理工具(CLI)')
  .version('0.1.0')
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
  // 主动退出,避免长驻句柄(如 serve 之外的意外 listener)挂住进程
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
          return `${mark} ${p.id.slice(0, 8)}  ${p.name.padEnd(16)} ${p.path}  [${p.agents.join(', ')}]  skills: ${p.skills.length}`;
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
    .requiredOption('--path <path>', '项目根目录(绝对路径)')
    .requiredOption('--agents <ids>', '目标 agents,逗号分隔(如 claude-code,kimi-code)')
    .option('--mode <mode>', 'apply 模式: symlink|copy', 'symlink'),
).action(
  wrap(async (cmd, opts: { name: string; path: string; agents: string; mode: string }) => {
    if (!['symlink', 'copy'].includes(opts.mode)) {
      throw new Error('--mode 只能是 symlink 或 copy');
    }
    const agentIds = opts.agents.split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of agentIds) {
      if (!getAdapter(id)) throw new Error(`未知 agent: ${id}(可用: ${adapters.map((a) => a.id).join(', ')})`);
    }
    const p = await createProject({ name: opts.name, path: opts.path, agents: agentIds, applyMode: opts.mode as 'symlink' | 'copy' });
    out(cmd, p, () => `已创建项目 ${p.name}(${p.id})`);
  }),
);

leaf(projectCmd.command('show').description('项目详情').argument('<id|name>', '项目 id 或名称')).action(
  wrap(async (cmd, ref: string) => {
    const p = await findProject(ref);
    const registry = await readRegistry();
    const skills = registry.filter((s) => p.skills.includes(s.id));
    const { activeProjectId } = await listProjects();
    const detail = { ...p, active: p.id === activeProjectId, skillDetails: skills };
    out(cmd, detail, () => {
      const lines = [
        `项目: ${p.name} (${p.id})${p.id === activeProjectId ? '  [当前激活]' : ''}`,
        `路径: ${p.path}`,
        `apply 模式: ${p.applyMode}`,
        `目标 agents: ${p.agents.join(', ') || '(无)'}`,
        `上次 apply: ${fmtTime(p.lastAppliedAt)}`,
        `技能集(${skills.length}):`,
        ...skills.map((s) => `  ${s.id.padEnd(24)} ${s.name} - ${s.description}`),
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
      const lines = [`已切换到「${p.name}」并应用配置(${result.applied.length} 项)`];
      for (const a of result.applied) lines.push(`  [${a.agentId}] ${a.skillName} -> ${a.target} (${a.mode})`);
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
          const lines = [`已应用 ${result.applied.length} 项(项目「${p.name}」)`];
          for (const a of result.applied) lines.push(`  [${a.agentId}] ${a.skillName} -> ${a.target} (${a.mode})`);
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
    .option('--local <path>', '本地 skill 目录(需含合法 SKILL.md)'),
).action(
  wrap(async (cmd, opts: { github?: string; local?: string }) => {
    if (!!opts.github === !!opts.local) throw new Error('必须且只能指定 --github 或 --local 之一');
    if (opts.github) {
      const installed = await installFromGithub(opts.github);
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

leaf(skillCmd.command('remove').description('从库中卸载 skill').argument('<id>', 'skill id')).action(
  wrap(async (cmd, id: string) => {
    const ok = await uninstall(id);
    if (!ok) throw new Error(`skill 不存在: ${id}`);
    out(cmd, { removed: id }, () => `已卸载: ${id}`);
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

// ---------- recommend ----------
leaf(
  program
    .command('recommend')
    .description('检测技术栈 + 关键词,输出 GitHub 高 star 推荐(按 star 降序)')
    .requiredOption('--path <path>', '项目根目录(用于技术栈检测)')
    .option('--keywords <words>', '额外关键词,逗号分隔'),
).action(
  wrap(async (cmd, opts: { path: string; keywords?: string }) => {
    const abs = path.resolve(opts.path);
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

// ---------- serve ----------
program
  .command('serve')
  .description('启动 Web GUI 服务(默认端口 5174)')
  .option('--port <port>', '监听端口', '5174')
  .action(
    wrap(async (_cmd, opts: { port: string }) => {
      const server = await startServer(Number(opts.port));
      console.log(`Skills SwitchTool 已启动: http://localhost:${serverPort(server)}`);
      // serve 是长驻命令:保持进程,不 return 后由 listener 维持事件循环
    }),
  );

await program.parseAsync(process.argv);
