/**
 * tui.ts —— 终端交互面板(TUI):不带子命令启动 ssw/skills 时进入。
 * 零依赖实现:stdin raw 模式解析按键,ANSI 转义序列渲染,不引入 blessed/Ink。
 * 主视图 = 项目列表(仿 cc-switch 的切换面板):↑↓ 移动光标,Enter 切换并 apply;
 * a apply / u unapply / r 回滚 / s 技能库 / m MCP 库 / g 全局共享 / c 推荐库 / q 或 Ctrl-C 退出,Esc 返回项目视图。
 * 全局共享视图里 a/u/r 作用于全局(用户级)物化;技能库/MCP 库/推荐库为只读视图(增删改走 CLI 子命令)。
 */
import { adapters } from './adapters/index.js';
import { applyProject, unapplyProject } from './core/apply.js';
import { listCatalogWithInstalled, type CatalogEntryWithInstalled } from './core/catalog.js';
import {
  applyGlobal,
  readGlobal,
  rollbackGlobal,
  unapplyGlobal,
  type GlobalProfile,
} from './core/global.js';
import { listSkills } from './core/library.js';
import { listMcps } from './core/mcps.js';
import { listProjects, setActiveProject } from './core/projects.js';
import { rollback } from './core/snapshot.js';
import type { McpEntry, Project, SkillEntry } from './core/types.js';

type View = 'projects' | 'skills' | 'mcps' | 'global' | 'catalog';

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
        lines.push('(暂无项目,先用 ssw project create 创建)');
      }
      state.projects.forEach((p, i) => {
        const mark = p.id === state.activeProjectId ? '*' : ' ';
        const line = `${mark} ${p.name.padEnd(16)} ${cut(p.path, 32).padEnd(32)} [${p.agents.join(',')}]  skills: ${p.skills.length}  mcps: ${p.mcps.length}`;
        lines.push(i === state.cursor ? `${INV} ${cut(line, cols - 2)} ${RESET}` : ` ${cut(line, cols - 2)}`);
      });
      lines.push('');
      lines.push(`${DIM}↑↓ 移动  Enter 切换并 apply  a apply  u unapply  r 回滚  s 技能库  m MCP库  g 全局共享  c 推荐库  q 退出${RESET}`);
    } else if (state.view === 'skills') {
      lines.push(`技能库(${state.skills.length}):`);
      lines.push('');
      if (!state.skills.length) {
        lines.push('(库为空,先用 ssw skill add/init 添加)');
      }
      for (const s of state.skills.slice(0, rows - 8)) {
        lines.push(`  ${s.id.padEnd(28)} ${cut(s.name, 16).padEnd(16)} [${s.source.type}]  ${cut(s.description, 24)}`);
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
    } else {
      lines.push(`推荐库(${state.catalog.length}):  ${DIM}安装: ssw catalog install <id>${RESET}`);
      lines.push('');
      for (const e of state.catalog.slice(0, rows - 8)) {
        const mark = e.installed ? '✓' : ' ';
        const star = e.stars > 0 ? ` ★${e.stars}` : '';
        lines.push(` ${mark} ${cut(e.id, 42).padEnd(42)} [${e.category}]${star}  ${cut(e.name, 18)}`);
      }
      lines.push('');
      lines.push(`${DIM}Esc 返回项目视图  q 退出${RESET}`);
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
      if (state.view !== 'projects') return; // 技能库/MCP 库/推荐库为只读视图,只响应 Esc/q
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
