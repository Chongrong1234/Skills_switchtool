/**
 * tui.ts —— 终端交互面板(TUI):不带子命令启动 ssw/skills 时进入。
 * 零依赖实现:stdin raw 模式解析按键,ANSI 转义序列渲染,不引入 blessed/Ink。
 * 主视图 = 项目列表(仿 cc-switch 的切换面板):↑↓ 移动光标,Enter 切换并 apply;
 * n 新建项目(依次询问名称/路径/agents/模式/开发需求——与 GUI 新建项目弹窗同口径,填了需求则 AI 推荐并整体绑定);
 * x 删除项目档案(y 二次确认;只删档案不动磁盘文件,同 CLI project remove);
 * a apply / u unapply / r 回滚 / i AI 推荐 / s 技能库 / m MCP 库 / g 全局共享 / c 推荐库 / d 环境自检 / q 或 Ctrl-C 退出,Esc 返回项目视图。
 * 全局共享视图里 a/u/r 作用于全局(用户级)物化;推荐库视图内 c 循环切换分类过滤、k 循环切换类型过滤(全部 → 仅 skills → 仅 MCP,
 * skills 与 MCP 的浏览/下载分流);
 * AI 推荐视图(i 键输入开发需求后进入)内 a 把推荐全部并入光标项目;推荐含本地技能库与 GitHub 联网两路
 * (联网部分只读,安装走 CLI ssw skill add --github);技能库/MCP 库/推荐库为只读视图(增删改走 CLI 子命令)。
 */
import path from 'node:path';
import readline from 'node:readline';
import { adapters, getAdapter } from './adapters/index.js';
import { aiRecommendSkills, type AiGithubRecommendation, type AiRecommendedSkill } from './core/ai.js';
import { applyProject, unapplyProject } from './core/apply.js';
import { CATALOG_CATEGORIES, listCatalogWithInstalled, type CatalogEntryWithInstalled } from './core/catalog.js';
import {
  applyGlobal,
  readGlobal,
  rollbackGlobal,
  unapplyGlobal,
  type GlobalProfile,
} from './core/global.js';
import { listSkills } from './core/library.js';
import { listMcps } from './core/mcps.js';
import { createProject, deleteProject, listProjects, setActiveProject, setProjectSkills } from './core/projects.js';
import { rollback } from './core/snapshot.js';
import { runDoctor, type DoctorReport } from './core/doctor.js';
import type { McpEntry, Project, SkillEntry } from './core/types.js';

type View = 'projects' | 'skills' | 'mcps' | 'global' | 'catalog' | 'doctor' | 'ai';

interface State {
  view: View;
  cursor: number;
  /** 最近一次操作的结果/错误,渲染在底部状态行 */
  message: string;
  /** 异步操作进行中时吞掉按键,防止并发 apply */
  busy: boolean;
  projects: Project[];
  activeProjectId: string | null;
  skills: SkillEntry[];
  mcps: McpEntry[];
  globalProfile: GlobalProfile;
  catalog: CatalogEntryWithInstalled[];
  /** 推荐库分类过滤('' = 全部);推荐库视图内按 c 循环切换 */
  catalogCategory: string;
  /** 推荐库类型过滤('' = 全部);推荐库视图内按 k 循环切换(skills 与 MCP 分流) */
  catalogKind: '' | 'skill' | 'mcp';
  /** 环境自检结果(null = 尚未运行;d 键触发) */
  doctor: DoctorReport | null;
  /** AI 推荐结果(i 键触发;绑定作用的目标项目随结果一起存) */
  aiRec: { projectId: string; items: AiRecommendedSkill[]; github: AiGithubRecommendation[]; message?: string; githubMessage?: string } | null;
}

const INV = '\x1b[7m'; // 反色(光标行)
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** 截断到可视宽度(简单按字符数,中文宽字符场景下够用) */
function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export async function startTui(): Promise<void> {
  const state: State = {
    view: 'projects',
    cursor: 0,
    message: '',
    busy: false,
    projects: [],
    activeProjectId: null,
    skills: [],
    mcps: [],
    globalProfile: { skills: [], agents: [], applyMode: 'symlink' },
    catalog: [],
    catalogCategory: '',
    catalogKind: '',
    doctor: null,
    aiRec: null,
  };

  async function reload(): Promise<void> {
    const data = await listProjects();
    state.projects = data.projects;
    state.activeProjectId = data.activeProjectId;
    if (state.cursor >= state.projects.length) {
      state.cursor = Math.max(0, state.projects.length - 1);
    }
    state.skills = await listSkills();
    state.mcps = await listMcps();
    state.globalProfile = await readGlobal();
    state.catalog = await listCatalogWithInstalled();
  }

  function render(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const lines: string[] = [];
    lines.push(`${BOLD}Skills SwitchTool${RESET}  ${DIM}中央库 + 项目切换(终端面板)${RESET}`);
    lines.push('');

    if (state.view === 'projects') {
      const active = state.projects.find((p) => p.id === state.activeProjectId);
      lines.push(`当前项目: ${active ? `${BOLD}${active.name}${RESET}  ${DIM}${active.path}${RESET}` : '(未激活)'}`);
      lines.push('');
      if (!state.projects.length) {
        lines.push('(暂无项目,按 n 新建,或用 ssw project create)');
      }
      state.projects.forEach((p, i) => {
        const mark = p.id === state.activeProjectId ? '*' : ' ';
        const line = `${mark} ${p.name.padEnd(16)} ${cut(p.path, 32).padEnd(32)} [${p.agents.join(',')}]  skills: ${p.skills.length}  mcps: ${p.mcps.length}`;
        lines.push(i === state.cursor ? `${INV} ${cut(line, cols - 2)} ${RESET}` : ` ${cut(line, cols - 2)}`);
      });
      // 光标项目的绑定摘要:列表行只有数量,这里给出具体名字,免得为看绑定切来切去
      const cur = state.projects[state.cursor];
      if (cur) {
        const skillNames = cur.skills.map((id) => state.skills.find((s) => s.id === id)?.name ?? id);
        const summary = `└ ${cur.name}: ${skillNames.join(', ') || '(未绑定技能)'}` +
          (cur.mcps.length ? `  |  MCP: ${cur.mcps.join(', ')}` : '');
        lines.push(`${DIM}${cut(summary, cols - 2)}${RESET}`);
      }
      lines.push('');
      lines.push(`${DIM}↑↓ 移动  Enter 切换并 apply  n 新建  x 删除  a apply  u unapply  r 回滚  i AI推荐  s 技能库  m MCP库  g 全局共享  c 推荐库  d 自检  q 退出${RESET}`);
    } else if (state.view === 'skills') {
      lines.push(`技能库(${state.skills.length}):`);
      lines.push('');
      if (!state.skills.length) {
        lines.push('(库为空,先用 ssw skill add/init 添加)');
      }
      for (const s of state.skills.slice(0, rows - 8)) {
        const hot = `${s.stars ? ` ★${s.stars}` : ''}${s.useCount ? ` 用${s.useCount}` : ''}`;
        lines.push(`  ${s.id.padEnd(28)} ${cut(s.name, 16).padEnd(16)} [${s.source.type}]${hot}  ${cut(s.description, 24)}`);
      }
      lines.push('');
      lines.push(`${DIM}Esc 返回项目视图  q 退出${RESET}`);
    } else if (state.view === 'mcps') {
      lines.push(`MCP 库(${state.mcps.length}):`);
      lines.push('');
      if (!state.mcps.length) {
        lines.push('(库为空,先用 ssw mcp add 添加)');
      }
      for (const m of state.mcps.slice(0, rows - 8)) {
        const target = m.transport === 'stdio' ? `${m.command} ${(m.args ?? []).join(' ')}` : m.url;
        lines.push(`  ${m.name.padEnd(20)} [${m.transport}]  ${cut(target ?? '', 40)}`);
      }
      lines.push('');
      lines.push(`${DIM}Esc 返回项目视图  q 退出${RESET}`);
    } else if (state.view === 'global') {
      const g = state.globalProfile;
      lines.push(`全局共享(用户级):  ${DIM}一次配置,这些 agent 的所有项目共享${RESET}`);
      lines.push('');
      lines.push(
        `目标 agents: ${g.agents.length ? g.agents.join(', ') : '(未设置,用 ssw global agents 设置)'}   模式: ${g.applyMode}   上次 apply: ${g.lastAppliedAt ?? '(从未)'}`,
      );
      lines.push('');
      if (!g.skills.length) {
        lines.push('(未绑定 skills,用 ssw global bind <skillId...> 设置)');
      }
      for (const id of g.skills.slice(0, rows - 10)) {
        const s = state.skills.find((x) => x.id === id);
        lines.push(`  ${id.padEnd(40)} ${s ? cut(s.name, 20) : `${DIM}(库中已删除)${RESET}`}`);
      }
      lines.push('');
      lines.push(`${DIM}a apply  u unapply  r 回滚  Esc 返回项目视图  q 退出${RESET}`);
    } else if (state.view === 'catalog') {
      const catName = (id: string) => CATALOG_CATEGORIES.find((c) => c.id === id)?.name ?? id;
      // 类型与分类两个维度可叠加:先按 kind 分流(skills/MCP),再按分类过滤
      const filtered = state.catalog
        .filter((e) => !state.catalogKind || (e.kind ?? 'skill') === state.catalogKind)
        .filter((e) => !state.catalogCategory || e.category === state.catalogCategory);
      const catLabel = state.catalogCategory ? catName(state.catalogCategory) : '全部';
      const kindLabel = state.catalogKind === 'skill' ? '仅 skills' : state.catalogKind === 'mcp' ? '仅 MCP' : '全部';
      lines.push(`推荐库(${filtered.length}/${state.catalog.length})  类型: ${kindLabel}  分类: ${catLabel}  ${DIM}安装: ssw catalog install <id>${RESET}`);
      lines.push('');
      for (const e of filtered.slice(0, rows - 8)) {
        const mark = e.installed ? '✓' : ' ';
        const star = e.stars > 0 ? ` ★${e.stars}` : '';
        lines.push(` ${mark} ${cut(e.id, 42).padEnd(42)} [${catName(e.category)}]${star}  ${cut(e.name, 18)}`);
      }
      lines.push('');
      lines.push(`${DIM}c 切换分类  k 切换类型  Esc 返回项目视图  q 退出${RESET}`);
    } else if (state.view === 'doctor') {
      lines.push('环境自检:');
      lines.push('');
      const d = state.doctor;
      if (!d) {
        lines.push('(按 d 运行自检)');
      } else {
        const icon = { ok: '✓', warn: '⚠', error: '✗' } as const;
        for (const c of d.checks.slice(0, rows - 10)) {
          lines.push(` ${icon[c.level]} ${cut(c.label, cols - 6)}`);
          if (c.hint) lines.push(`     ${DIM}${cut(c.hint, cols - 8)}${RESET}`);
        }
        lines.push('');
        lines.push(
          `统计: skills ${d.stats.skills} / MCP ${d.stats.mcps} / 项目 ${d.stats.projects}` +
            (d.stats.activeProject ? `(当前激活: ${d.stats.activeProject})` : ''),
        );
      }
      lines.push('');
      lines.push(`${DIM}d 重新自检  Esc 返回项目视图  q 退出${RESET}`);
    } else if (state.view === 'ai') {
      lines.push('AI 技能推荐(模型读本地技能库 + 联网搜 GitHub):');
      lines.push('');
      const rec = state.aiRec;
      if (!rec || (!rec.items.length && !rec.github.length)) {
        lines.push(`(${rec?.message ?? rec?.githubMessage ?? '暂无结果——在项目视图按 i 输入开发需求'})`);
      } else {
        const proj = state.projects.find((p) => p.id === rec.projectId);
        lines.push(`目标项目: ${proj?.name ?? rec.projectId}`);
        lines.push('');
        if (rec.items.length) {
          for (const it of rec.items.slice(0, rows - 14)) {
            lines.push(`  ${cut(it.name, 20).padEnd(20)} ${cut(it.id, 34)}`);
            if (it.reason) lines.push(`      ${DIM}${cut(it.reason, cols - 8)}${RESET}`);
          }
        } else if (rec.message) {
          lines.push(`(${rec.message})`);
        }
        if (rec.github.length) {
          lines.push('');
          lines.push('GitHub 联网推荐(未入库;安装: ssw skill add --github <owner/repo>):');
          const remain = Math.max(0, rows - 16 - rec.items.length * 2);
          for (const g of rec.github.slice(0, remain)) {
            lines.push(`  ★${g.stars}  ${cut(g.repo, 40)}  ${DIM}${cut(g.description, cols - 52)}${RESET}`);
          }
        } else if (rec.githubMessage) {
          lines.push(`${DIM}(${rec.githubMessage})${RESET}`);
        }
      }
      lines.push('');
      lines.push(`${DIM}a 全部绑定到项目  Esc 返回项目视图  q 退出${RESET}`);
    }

    if (state.message) {
      lines.push('');
      lines.push(state.message.split('\n').slice(0, 4).join('\n'));
    }
    // 清屏 + 光标回左上角,整帧重绘;面板行数少,闪烁可接受
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  }

  /** 执行异步操作:期间锁住按键,结束后刷新数据并重绘 */
  async function run(action: () => Promise<string>): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    try {
      state.message = await action();
    } catch (err) {
      state.message = `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      await reload();
    } catch {
      // 数据读取失败不致命,保留旧列表
    }
    state.busy = false;
    render();
  }

  function currentProject(): Project | undefined {
    return state.projects[state.cursor];
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (key: string): void => {
      // Ctrl-C 或 q:退出面板
      if (key === '\u0003' || key === 'q') {
        cleanup();
        return;
      }
      if (state.busy) return;
      if (key === '\u001b') {
        // Esc:返回项目视图(方向键是 ESC 开头的多字节序列,不会被这条命中——它们不止 1 字节)
        if (state.view !== 'projects') {
          state.view = 'projects';
          state.message = '';
          render();
        }
        return;
      }
      // 全局共享视图:a/u/r 作用于全局(用户级)物化
      if (state.view === 'global') {
        switch (key) {
          case 'a':
            void run(async () => {
              const r = await applyGlobal();
              const warn = r.warnings.length ? `\n警告: ${r.warnings.join('; ')}` : '';
              return `✓ 全局共享已应用 skills ${r.applied.length} 项${warn}`;
            });
            break;
          case 'u':
            void run(async () => {
              const r = await unapplyGlobal();
              return `✓ 全局共享已移除 ${r.removed.length} 项`;
            });
            break;
          case 'r':
            void run(async () => {
              const r = await rollbackGlobal();
              if (!r.restored) throw new Error(r.detail);
              return `✓ ${r.detail}`;
            });
            break;
        }
        return;
      }
      if (state.view === 'catalog') {
        // 推荐库视图:c 循环切换分类过滤(全部 → 各分类 → 全部)
        if (key === 'c') {
          const ids = CATALOG_CATEGORIES.map((c) => c.id);
          const idx = ids.indexOf(state.catalogCategory);
          state.catalogCategory = idx >= 0 && idx + 1 < ids.length ? ids[idx + 1] : '';
          render();
        }
        // k 循环切换类型过滤(全部 → 仅 skills → 仅 MCP → 全部)
        if (key === 'k') {
          const kinds = ['', 'skill', 'mcp'] as const;
          const idx = kinds.indexOf(state.catalogKind);
          state.catalogKind = kinds[(idx + 1) % kinds.length];
          render();
        }
        return;
      }
      if (state.view === 'doctor') {
        // 自检视图:d 重跑一次(结果走 message 行反馈 ok/error)
        if (key === 'd') {
          void run(async () => {
            state.doctor = await runDoctor();
            return state.doctor.ok ? '✓ 自检通过' : '✗ 自检发现 error 级问题,见上方列表';
          });
        }
        return;
      }
      if (state.view === 'ai') {
        // AI 推荐视图:a 把推荐结果整体并入目标项目技能集(与已有绑定并集去重)
        if (key === 'a' && state.aiRec?.items.length) {
          const rec = state.aiRec;
          void run(async () => {
            const p = state.projects.find((x) => x.id === rec.projectId);
            if (!p) throw new Error('项目已不存在');
            await setProjectSkills(p.id, [...new Set([...p.skills, ...rec.items.map((i) => i.id)])]);
            return `✓ 已把 ${rec.items.length} 个 AI 推荐技能并入「${p.name}」(a apply 生效)`;
          });
        }
        return;
      }
      if (state.view !== 'projects') return; // 技能库/MCP 库为只读视图,只响应 Esc/q
      switch (key) {
        case '\u001b[A': // ↑
          state.cursor = Math.max(0, state.cursor - 1);
          render();
          break;
        case '\u001b[B': // ↓
          state.cursor = Math.min(Math.max(0, state.projects.length - 1), state.cursor + 1);
          render();
          break;
        case 's':
          state.view = 'skills';
          state.message = '';
          render();
          break;
        case 'm':
          state.view = 'mcps';
          state.message = '';
          render();
          break;
        case 'g':
          state.view = 'global';
          state.message = '';
          render();
          break;
        case 'c':
          state.view = 'catalog';
          state.message = '';
          render();
          break;
        case 'd': // 进入自检视图并立即跑一遍
          state.view = 'doctor';
          state.message = '';
          void run(async () => {
            state.doctor = await runDoctor();
            return state.doctor.ok ? '✓ 自检通过' : '✗ 自检发现 error 级问题,见上方列表';
          });
          break;
        case 'n': { // 新建项目:readline 依次询问,字段与 GUI 新建项目弹窗同口径(名称/路径/agents/模式/开发需求)
          void (async () => {
            const name = (await ask('项目名称(留空取消)> ')).trim();
            if (!name) {
              state.message = '已取消新建';
              render();
              return;
            }
            const pathInput = (await ask(`项目路径(缺省当前目录 ${process.cwd()})> `)).trim();
            // agents 缺省取本机检测到的具体 agent(排除恒真 'agents'),与 CLI project create 同口径
            const detected = adapters.filter((a) => a.id !== 'agents' && a.detect()).map((a) => a.id);
            const agentsInput = (await ask(`目标 agents 逗号分隔(缺省检测值: ${detected.join(',') || '无'})> `)).trim();
            const modeInput = (await ask('apply 模式 symlink/copy(缺省 symlink)> ')).trim();
            const requirement = (await ask('开发需求(留空跳过;填了则 AI 读技能库推荐并绑定)> ')).trim();
            let created = false;
            await run(async () => {
              const mode = modeInput || 'symlink';
              if (mode !== 'symlink' && mode !== 'copy') throw new Error(`模式只能是 symlink 或 copy: ${mode}`);
              const agentIds = agentsInput ? agentsInput.split(',').map((s) => s.trim()).filter(Boolean) : detected;
              if (!agentIds.length) {
                throw new Error(`未检测到任何 agent,请在 agents 一项显式填写(可用: ${adapters.map((a) => a.id).join(', ')})`);
              }
              for (const id of agentIds) {
                if (!getAdapter(id)) throw new Error(`未知 agent: ${id}(可用: ${adapters.map((a) => a.id).join(', ')})`);
              }
              const p = await createProject({ name, path: path.resolve(pathInput || '.'), agents: agentIds, applyMode: mode });
              created = true;
              let extra = '';
              if (requirement) {
                const r = await aiRecommendSkills({ requirement, projectName: name });
                if (r.items.length) {
                  await setProjectSkills(p.id, r.items.map((s) => s.id));
                  extra = `;AI 已推荐并绑定 ${r.items.length} 个技能`;
                } else {
                  extra = `;AI 推荐: ${r.message ?? '无结果'}`;
                }
                if (r.github.length) extra += `;GitHub 联网推荐 ${r.github.length} 个(ssw ai recommend "<需求>" 查看)`;
              }
              return `✓ 已创建项目「${p.name}」(${p.id.slice(0, 8)}…)${extra},Enter 切换并 apply`;
            });
            if (created) {
              // 光标落到新项目(createProject 追加在列表末尾)
              state.cursor = Math.max(0, state.projects.length - 1);
              render();
            }
          })();
          break;
        }
        case 'x': { // 删除项目档案:y 二次确认;只删档案不动磁盘文件(同 CLI project remove)
          const p = currentProject();
          if (!p) return;
          void (async () => {
            const ans = (await ask(`确认删除项目「${p.name}」?(仅删档案,不动磁盘文件)y/N> `)).trim().toLowerCase();
            if (ans !== 'y' && ans !== 'yes') {
              state.message = '已取消删除';
              render();
              return;
            }
            await run(async () => {
              await deleteProject(p.id);
              return `✓ 已删除项目「${p.name}」档案`;
            });
          })();
          break;
        }
        case 'i': { // AI 推荐:读一行开发需求 → 模型从技能库挑技能 → 进 AI 视图(a 绑定)
          const p = currentProject();
          if (!p) return;
          void (async () => {
            const requirement = (await ask('开发需求(一两句话)> ')).trim();
            if (!requirement) {
              render();
              return;
            }
            await run(async () => {
              const r = await aiRecommendSkills({ requirement, projectName: p.name });
              state.aiRec = { projectId: p.id, items: r.items, github: r.github, message: r.message, githubMessage: r.githubMessage };
              if (r.items.length || r.github.length) {
                state.view = 'ai';
                const parts = [
                  r.items.length ? `本地 ${r.items.length} 个(按 a 全部并入「${p.name}」)` : '',
                  r.github.length ? `GitHub ${r.github.length} 个(CLI: ssw skill add --github 安装)` : '',
                ].filter(Boolean);
                return `AI(${r.model ?? '模型'})推荐: ${parts.join(' + ')}`;
              }
              return `AI 推荐: ${r.message ?? r.githubMessage ?? '无结果'}`;
            });
          })();
          break;
        }
        case '\r': { // Enter:切换激活项目并 apply
          const p = currentProject();
          if (!p) return;
          void run(async () => {
            await setActiveProject(p.id);
            const r = await applyProject(p.id);
            const warn = r.warnings.length ? `\n警告: ${r.warnings.join('; ')}` : '';
            return `✓ 已切换到「${p.name}」并应用 skills ${r.applied.length} 项、MCP ${r.mcpApplied.length} 项${warn}`;
          });
          break;
        }
        case 'a': {
          const p = currentProject();
          if (!p) return;
          void run(async () => {
            const r = await applyProject(p.id);
            const warn = r.warnings.length ? `\n警告: ${r.warnings.join('; ')}` : '';
            return `✓ 已应用 skills ${r.applied.length} 项、MCP ${r.mcpApplied.length} 项(项目「${p.name}」)${warn}`;
          });
          break;
        }
        case 'u': {
          const p = currentProject();
          if (!p) return;
          void run(async () => {
            const r = await unapplyProject(p.id);
            return `✓ 已移除 ${r.removed.length} 项(项目「${p.name}」)`;
          });
          break;
        }
        case 'r': {
          const p = currentProject();
          if (!p) return;
          void run(async () => {
            const r = await rollback(p.id);
            if (!r.restored) throw new Error(r.detail);
            return `✓ ${r.detail}`;
          });
          break;
        }
      }
    };
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      // 退出时清屏,不污染终端滚动历史之外的残留
      process.stdout.write('\x1b[2J\x1b[H');
      resolve();
    };

    /** 临时退出 raw 模式读一行输入(AI 推荐的开发需求);结束后恢复按键监听与整帧渲染 */
    const ask = (question: string): Promise<string> =>
      new Promise((resolveAsk) => {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        const rl = readline.createInterface({ input: stdin, output: process.stdout });
        // Ctrl-C 只会触发 close 而不会回调 question,用 done 兜底恢复监听,避免面板死键
        let done = false;
        const finish = (ans: string): void => {
          if (done) return;
          done = true;
          rl.close();
          stdin.setRawMode(true);
          stdin.resume();
          stdin.on('data', onData);
          resolveAsk(ans);
        };
        rl.question(`\n${question}`, finish);
        rl.on('close', () => finish(''));
      });

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);

    // 检测到的 agent 数量放进首屏状态行;加载失败直接以错误信息开局
    reload()
      .then(() => {
        const detected = adapters.filter((a) => a.detect()).map((a) => a.id);
        state.message = `${DIM}检测到 agents: ${detected.join(', ') || '(无)'}${RESET}`;
        render();
      })
      .catch((err) => {
        state.message = `错误: ${err instanceof Error ? err.message : String(err)}`;
        render();
      });
  });
}
