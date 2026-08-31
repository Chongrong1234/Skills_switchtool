/**
 * doctor 环境自检:给"装不上 / 不生效"类问题一个自助排障入口。
 * 检查项:数据目录可写、git 可用(GitHub 安装链路的硬依赖)、agent 检测、
 * 五个 JSON 数据文件(registry/projects/mcps/global/update)的健康度。
 *
 * 设计决策:
 * - 只读检测为主;唯一副作用是 ensureSkeleton() 建目录骨架,与正常启动行为一致。
 * - 运行时对损坏 JSON 是容错吞掉的(readJsonSafe 返回空),doctor 的职责正是把
 *   "被吞掉的损坏"暴露出来——否则用户看到的是"数据神秘消失"。
 * - git 缺失是 warn 而非 error:只有 GitHub 安装/更新需要它,本地安装不受影响。
 * - agent 检测排除恒真的通用 'agents' 适配器(它永远"已检测",纳入会让检查失去意义)。
 * CLI(ssw doctor)/ REST(GET /api/doctor)/ TUI(d 键)/ 桌面 GUI(设置弹窗)共用本模块。
 */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { adapters } from '../adapters/index.js';
import { listMcps } from './mcps.js';
import {
  ensureSkeleton,
  globalFile,
  mcpsFile,
  projectsFile,
  registryFile,
  sswHome,
  updateFile,
} from './paths.js';
import { listProjects } from './projects.js';
import { readRegistry } from './registry.js';

export type DoctorLevel = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  id: string;        // 稳定标识(测试断言 / 前端渲染用)
  level: DoctorLevel;
  label: string;     // 一行人类可读结论
  hint?: string;     // 修复建议(warn/error 时尽量给出)
}

export interface DoctorReport {
  ok: boolean; // 无 error 级检查项(error 才影响 CLI 退出码)
  sswHome: string;
  checks: DoctorCheck[];
  stats: {
    skills: number;
    mcps: number;
    projects: number;
    activeProject: string | null; // 激活项目名(无则 null)
  };
}

/** git --version 探活(10s 超时),返回版本字符串;不可用返回 null。仅检测,不走 library 的安装链路 */
function probeGit(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const child = spawn('git', ['--version'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, 10_000);
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => {
      // ENOENT 等:git 不在 PATH
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? out.trim() : null);
    });
  });
}

/** 单个 JSON 数据文件健康检查:不存在=首用正常;存在但解析失败=error(运行时会容错成空数据,必须显式告知) */
async function checkJsonFile(id: string, file: string, label: string): Promise<DoctorCheck> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { id, level: 'ok', label: `${label}: 不存在(首次使用,写入时自动创建)` };
  }
  try {
    JSON.parse(raw);
    return { id, level: 'ok', label: `${label}: 正常` };
  } catch (err) {
    return {
      id,
      level: 'error',
      label: `${label}: 损坏(${err instanceof Error ? err.message : String(err)})`,
      hint: `运行时已按空数据容错(表现为"数据消失");请修复或删除 ${file} 后重试`,
    };
  }
}

/** 跑全套自检。任何单项失败都不中断(这本身就是排障工具) */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 数据目录:先建骨架(与启动行为一致),再验证可写
  const home = sswHome();
  try {
    await ensureSkeleton();
    await fs.access(home, fs.constants.W_OK);
    checks.push({ id: 'ssw-home', level: 'ok', label: `数据目录可写: ${home}` });
  } catch (err) {
    checks.push({
      id: 'ssw-home',
      level: 'error',
      label: `数据目录不可写: ${home}(${err instanceof Error ? err.message : String(err)})`,
      hint: '检查目录权限,或用 SSW_HOME 环境变量指向一个可写目录',
    });
  }

  // git:GitHub 安装/更新的硬依赖,其余功能不受影响 → warn 而非 error
  const gitVersion = await probeGit();
  checks.push(
    gitVersion
      ? { id: 'git', level: 'ok', label: `git 可用(${gitVersion})` }
      : {
          id: 'git',
          level: 'warn',
          label: 'git 不可用(未安装或不在 PATH)',
          hint: '从 GitHub 安装/更新 skill 需要 git;请先安装 Git 并加入 PATH。本地安装、推荐库浏览等功能不受影响',
        },
  );

  // agent 检测:'agents' 是恒真的通用互操作目录,纳入会让"零检测"永远不报,故只看具体 agent
  const detected = adapters.filter((a) => a.id !== 'agents' && a.detect());
  checks.push(
    detected.length
      ? { id: 'agents', level: 'ok', label: `检测到 ${detected.length} 个 agent: ${detected.map((a) => a.id).join(', ')}` }
      : {
          id: 'agents',
          level: 'warn',
          label: '未检测到任何具体 agent(Claude Code / Kimi Code / Cursor 等)',
          hint: 'apply 需要至少一个目标 agent;也可显式选用通用互操作目录 agents(见 ssw agents)',
        },
  );

  // 五个 JSON 数据文件健康度(损坏时运行时会容错成空,这里负责暴露)
  checks.push(await checkJsonFile('registry', registryFile(), 'skills 注册表 registry.json'));
  checks.push(await checkJsonFile('projects', projectsFile(), '项目档案 projects.json'));
  checks.push(await checkJsonFile('mcps', mcpsFile(), 'MCP 注册表 mcps.json'));
  checks.push(await checkJsonFile('global', globalFile(), '全局共享档案 global.json'));
  checks.push(await checkJsonFile('update', updateFile(), '自动更新配置 update.json'));

  // 统计(读取走容错路径,与运行时一致)
  const [skills, mcps, pdata] = await Promise.all([readRegistry(), listMcps(), listProjects()]);
  const active = pdata.projects.find((p) => p.id === pdata.activeProjectId);

  return {
    ok: checks.every((c) => c.level !== 'error'),
    sswHome: home,
    checks,
    stats: {
      skills: skills.length,
      mcps: mcps.length,
      projects: pdata.projects.length,
      activeProject: active?.name ?? null,
    },
  };
}
