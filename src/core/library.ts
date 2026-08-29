/**
 * 中央库:安装(github→git clone --depth 1 / local→复制)、卸载、更新、自建脚手架。
 * 库是唯一事实来源,所有 skill 实体都存放在 ~/.skills-switch/library/ 下。
 * git 调用统一走 runGit:有超时(默认 120s,SSW_GIT_TIMEOUT_MS 覆盖)且禁用交互式
 * 凭据提示——本工具常跑在 GUI/服务进程里,git 一旦挂起或在用户看不到的终端等输入,
 * 表现就是前端永远"安装中…"。clone/pull 带 --progress,进度段解析后兵分两路:
 * TTY 下渲染单行进度条到 stderr;同时写入 gitProgress 内存表供 /api/progress
 * 轮询(GUI/Electron 进度条)——大仓库克隆要好几分钟,零输出会让用户以为死机。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getAdapter } from '../adapters/index.js';
import { libraryDir } from './paths.js';
import { detachSkillFromProjects } from './projects.js';
import { getSkill, readRegistry, upsertSkill, writeRegistry } from './registry.js';
import type { SkillEntry } from './types.js';

export class LibraryError extends Error {}

/** git 调用默认超时:2 分钟;SSW_GIT_TIMEOUT_MS 可覆盖(慢网调大,测试调小) */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** 每次调用重读环境变量(同 paths.ts 的测试隔离约定);非法值回退默认 */
function gitTimeoutMs(): number {
  const raw = Number(process.env.SSW_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
}

/** 从 git 参数里提取真实子命令名(clone/pull),用于错误消息;-c/-C 各带一个值需跳过 */
function gitSubcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return args[0] ?? 'git';
}

/** 进度条字符宽度 */
const PROGRESS_BAR_WIDTH = 24;

/** 解析后的 git 进度段:pct 为 null 的是非百分比行(如 Cloning into '...') */
interface ProgressSegment {
  text: string;          // 去掉 remote: 前缀的整段原文
  phase: string | null;  // Receiving objects 等阶段名
  pct: number | null;
  rest: string;          // 百分比后的附加信息,如 (45/100), 1.0 MiB | 2.0 MiB/s
  done: boolean;         // 该阶段收尾(100% 或带 done.)
}

/** 解析 git --progress 的一段(段间 \r 或 \n 分隔);空段返回 null */
function parseProgressSegment(raw: string): ProgressSegment | null {
  const text = raw.trim().replace(/^remote:\s*/, '');
  if (!text) return null;
  const m = text.match(/^([A-Za-z][A-Za-z ]{0,30}):\s+(\d{1,3})%\s*(.*)$/);
  if (!m) return { text, phase: null, pct: null, rest: '', done: false };
  const pct = Math.min(100, Number(m[2]));
  return {
    text,
    phase: m[1],
    pct,
    rest: m[3].replace(/,?\s*done\.?\s*$/, ''),
    done: pct >= 100 || /done\.?\s*$/.test(m[3]),
  };
}

/** 进行中的 git 任务进度,key = label(同一仓库同一时刻只会有一个 clone/pull) */
export interface GitProgress {
  label: string;         // "克隆 owner/repo" / "更新 owner/repo"
  phase: string | null;
  pct: number | null;
  text: string;          // 附加信息(百分比行的 rest;非百分比行的整行)
  updatedAt: number;
}

const gitProgress = new Map<string, GitProgress>();

/** 进行中的 git 任务快照:server 的 GET /api/progress 轮询用(GUI/Electron 进度条) */
export function listGitProgress(): GitProgress[] {
  return [...gitProgress.values()];
}

/**
 * git 进度条渲染器(CLI 用):把进度段渲染成单行进度条写 stderr
 * (--json 的 stdout 保持干净)。仅 stderr 是 TTY 时输出;服务/GUI 进程非 TTY,
 * 自动静默——它们的进度走上面的 gitProgress 内存表,由 /api/progress 轮询。
 */
function createProgressRenderer(label: string): { renderSegment: (seg: ProgressSegment) => void; end: () => void } {
  let midLine = false;   // 当前有一行未换行的进度条
  let lastPhase = '';    // 上一阶段名;阶段切换时换行,避免覆盖上一阶段的收尾行
  const enabled = Boolean(process.stderr.isTTY);
  return {
    renderSegment(seg: ProgressSegment): void {
      if (!enabled) return;
      if (seg.phase === null || seg.pct === null) {
        // 非进度行(如 Cloning into '...',连接建立前的"存活证明"):整行打印
        process.stderr.write(`\r\x1b[K  ${label}: ${seg.text}\n`);
        midLine = false;
        lastPhase = '';
        return;
      }
      if (midLine && seg.phase !== lastPhase) process.stderr.write('\n');
      const filled = Math.round((seg.pct / 100) * PROGRESS_BAR_WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
      process.stderr.write(
        `\r\x1b[K  ${label}: ${seg.phase} [${bar}] ${String(seg.pct).padStart(3)}%${seg.rest ? `  ${seg.rest}` : ''}`,
      );
      midLine = !seg.done;
      if (seg.done) process.stderr.write('\n');
      lastPhase = seg.phase;
    },
    end(): void {
      if (enabled && midLine) {
        process.stderr.write('\n');
        midLine = false;
      }
    },
  };
}

/** 从 stderr 提取失败原因:剥掉进度段(百分比行),取最后几行有效内容 */
function summarizeStderr(stderr: string): string {
  return stderr
    .split(/[\r\n]+/)
    .map((s) => s.trim().replace(/^remote:\s*/, ''))
    .filter((s) => s && !/^[A-Za-z][A-Za-z ]{0,30}:\s+\d{1,3}%/.test(s))
    .slice(-6)
    .join('; ');
}

/** stdout+stderr 合计上限(等价旧 execFile 的 maxBuffer):防异常输出刷爆内存 */
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

/**
 * 执行 git 子命令。失败都包装成可读的 LibraryError 而不是裸崩溃/挂死:
 * - git 不在 PATH(spawn ENOENT,Windows 常见)
 * - 超时:主动 SIGTERM 子进程(网络挂起等)
 * - 凭据提示:GIT_TERMINAL_PROMPT=0 强制失败而非在控制终端等输入——
 *   GUI/服务进程里那个提示用户根本看不到,表现就是永久"安装中…"
 * 用 spawn 而非 execFile:流式读 stderr 才能实时渲染 clone/pull 进度条
 * (execFile 攒到结束才回调,大仓库几分钟零输出,用户以为死机)。
 */
async function runGit(args: string[], label?: string): Promise<void> {
  const sub = gitSubcommand(args);
  const timeoutMs = gitTimeoutMs();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    // git 不需要我们的 stdin,直接关掉(配合 GIT_TERMINAL_PROMPT=0 杜绝任何等输入)
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let outputOverflow = false;
    let settled = false;
    const progress = label ? createProgressRenderer(label) : null;
    let pending = ''; // 未遇到分隔符的半段,留到下一块拼上
    /** 处理一段完整进度段:更新内存表(GUI 轮询)+ 渲染 TTY 进度条 */
    const handleSegment = (raw: string): void => {
      if (!label) return;
      const seg = parseProgressSegment(raw);
      if (!seg) return;
      gitProgress.set(label, {
        label,
        phase: seg.phase,
        pct: seg.pct,
        text: seg.phase ? seg.rest : seg.text,
        updatedAt: Date.now(),
      });
      progress?.renderSegment(seg);
    };
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending.trim()) handleSegment(pending);
      progress?.end();
      if (label) gitProgress.delete(label); // 任务结束即摘表,GUI 请求返回后自行隐藏进度条
      if (err) reject(err);
      else resolve();
    };
    child.on('error', (err) => {
      // spawn 失败(典型:ENOENT,git 不在 PATH)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        done(new LibraryError('未找到 git 命令(请先安装 Git 并加入 PATH);从 GitHub 安装/更新 skill 需要 git'));
      } else {
        done(new LibraryError(`git ${sub} 启动失败: ${err.message}`));
      }
    });
    const onData = (which: 'stdout' | 'stderr') => (d: Buffer | string): void => {
      const s = String(d);
      if (which === 'stdout') stdout += s;
      else {
        stderr += s;
        pending += s;
        const parts = pending.split(/[\r\n]/);
        pending = parts.pop() ?? '';
        for (const segRaw of parts) handleSegment(segRaw);
      }
      if (!outputOverflow && stdout.length + stderr.length > MAX_GIT_OUTPUT) {
        outputOverflow = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    // 用 close 而非 exit:等 stdio 流刷完,stderr 才完整
    child.on('close', (code) => {
      if (killedByTimeout) {
        done(new LibraryError(
          `git ${sub} 超时(${Math.round(timeoutMs / 1000)}s 未完成):网络访问 GitHub 过慢或不可达,请检查网络/代理后重试`,
        ));
      } else if (outputOverflow) {
        done(new LibraryError(`git ${sub} 失败: 输出超过 ${Math.round(MAX_GIT_OUTPUT / 1024 / 1024)}MB 上限`));
      } else if (code === 0) {
        done();
      } else {
        done(new LibraryError(`git ${sub} 失败: ${summarizeStderr(stderr) || `退出码 ${code}`}`));
      }
    });
  });
}

/** skill 名称合法性:小写字母/数字/连字符开头规则 + Windows 保留名黑名单(CON/PRN 等建目录会失败) */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function assertValidSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new LibraryError(`skill 名称 "${name}" 非法:必须是小写字母/数字/连字符,且以字母或数字开头`);
  }
  if (WINDOWS_RESERVED.has(name)) {
    throw new LibraryError(`skill 名称 "${name}" 是 Windows 保留文件名,无法在 Windows 上创建目录,请改名`);
  }
}

/** 解析 SKILL.md 的 YAML frontmatter(仅支持单行 key: value,够用即可) */
export function parseFrontmatter(content: string): Record<string, string> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 校验一个目录是否是合法 skill:SKILL.md 存在且 frontmatter 的 name/description 非空。
 * 返回 { name, description } 或抛出 LibraryError。
 */
export async function validateSkillDir(dir: string): Promise<{ name: string; description: string }> {
  let content: string;
  try {
    content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    throw new LibraryError(`缺少 SKILL.md: ${dir}`);
  }
  const fm = parseFrontmatter(content);
  if (!fm || !fm.name || !fm.description) {
    throw new LibraryError(`SKILL.md frontmatter 非法(name/description 不能为空): ${dir}`);
  }
  // 名称会作为目录名(库内 + 各 agent 项目目录),必须在各平台文件系统上合法
  assertValidSkillName(fm.name);
  return { name: fm.name, description: fm.description };
}

/** SkillEntry → 库内实际目录 */
export function skillDirOf(entry: SkillEntry): string {
  if (entry.id.startsWith('local:')) {
    return path.join(libraryDir(), `local__${entry.id.slice('local:'.length)}`);
  }
  // "owner/repo:path"
  const [repoPart, subPath] = entry.id.split(':');
  const [owner, repo] = repoPart.split('/');
  const base = path.join(libraryDir(), `github__${owner}__${repo}`);
  return subPath ? path.join(base, subPath) : base;
}

function normalizeGithubUri(uri: string): { owner: string; repo: string; cloneUrl: string } {
  // 支持 "owner/repo" 简写与完整 URL
  const m =
    uri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/) ||
    uri.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw new LibraryError(`无法识别的 GitHub 地址: ${uri}`);
  const [, owner, repo] = m;
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/**
 * 规范化子目录参数:去掉首尾斜杠;拒绝空段、"."、".." 等越界成分。
 * 合法返回规范化后的相对路径;未传返回 undefined;非法抛 LibraryError。
 * 安全前提:subdir 会写进 SkillEntry.id 并参与拼库内路径(skillDirOf),必须拒绝
 *   - '\':Windows 上也是路径分隔符,'..\..' 会穿越到库外(uninstall 的递归 rm 会删库外目录)
 *   - ':':会撑爆 skillDirOf 的 split(':')(且是 Windows 非法字符)
 */
function normalizeSubdir(subdir?: string): string | undefined {
  if (subdir === undefined) return undefined;
  if (/[\\:]/.test(subdir)) {
    throw new LibraryError(`非法子目录: ${subdir}`);
  }
  const s = subdir.trim().replace(/^\/+|\/+$/g, '');
  if (!s || s.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new LibraryError(`非法子目录: ${subdir}`);
  }
  return s;
}

/**
 * 扫描 repoDir(或其中 subdir 子目录)的自身 + 第一层子目录,把合法 skill 登记入库。
 * subPath 是相对仓库根的路径,写进 SkillEntry.id 的 "owner/repo:<subPath>"。
 * 独立导出便于测试(installFromGithub 的 git clone 要网络,这部分不需要)。
 */
export async function registerSkillsIn(
  repoDir: string,
  repoId: string, // "owner/repo"
  uri: string,
  subdir?: string,
): Promise<SkillEntry[]> {
  const scanRoot = subdir ? path.join(repoDir, subdir) : repoDir;
  const stat = await fs.stat(scanRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new LibraryError(`仓库中不存在子目录: ${subdir}`);
  }
  // 收集候选目录:扫描根自身 + 第一层子目录
  const candidates: { subPath: string; dir: string }[] = [{ subPath: subdir ?? '', dir: scanRoot }];
  for (const ent of await fs.readdir(scanRoot, { withFileTypes: true })) {
    if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
      candidates.push({ subPath: subdir ? `${subdir}/${ent.name}` : ent.name, dir: path.join(scanRoot, ent.name) });
    }
  }

  const installed: SkillEntry[] = [];
  for (const c of candidates) {
    try {
      const { name, description } = await validateSkillDir(c.dir);
      const entry: SkillEntry = {
        id: `${repoId}:${c.subPath}`,
        name,
        description,
        source: { type: 'github', uri },
        tags: [],
        installedAt: new Date().toISOString(),
      };
      await upsertSkill(entry);
      installed.push(entry);
    } catch {
      // 该目录不是合法 skill,跳过
    }
  }
  return installed;
}

/**
 * 从 GitHub 安装:浅克隆后,根或第一层子目录中含 SKILL.md 的都登记入库。
 * subdir 可选:指定后以 <仓库>/<subdir> 为扫描根(主流合集仓库把 skills 放在 skills/ 子目录)。
 */
export async function installFromGithub(uri: string, subdir?: string): Promise<SkillEntry[]> {
  const { owner, repo, cloneUrl } = normalizeGithubUri(uri);
  const sub = normalizeSubdir(subdir);
  const dest = path.join(libraryDir(), `github__${owner}__${repo}`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(libraryDir(), { recursive: true });
  try {
    // -c core.longpaths=true:Windows 默认 260 字符路径上限,库路径叠加合集仓库深目录可能超限;
    // 其它平台该配置静默无效。--progress:stderr 已被管道接管,不显式要进度 git 就不汇报
    await runGit(['-c', 'core.longpaths=true', 'clone', '--progress', '--depth', '1', cloneUrl, dest], `克隆 ${owner}/${repo}`);
  } catch (err) {
    // clone 失败(含超时被 kill)不留半个仓库的残目录,避免污染后续同名安装
    await fs.rm(dest, { recursive: true, force: true }).catch(() => { /* 清理失败不掩盖原始错误 */ });
    if (err instanceof LibraryError) throw err;
    throw new LibraryError(`git clone 失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const installed = await registerSkillsIn(dest, `${owner}/${repo}`, uri, sub);
  if (installed.length === 0) {
    await fs.rm(dest, { recursive: true, force: true });
    throw new LibraryError(`仓库中未找到合法 skill(无 SKILL.md): ${uri}${sub ? `(子目录 ${sub})` : ''}`);
  }
  return installed;
}

/**
 * 判断两个路径是否指向同一个实际位置(基于 realpath,解析符号链接与盘符上的真实写法)。
 * 路径不存在时回退到 path.resolve 的结果。独立导出便于测试。
 * 用于"源即目标"的自杀式复制防护:纯字符串比较在 Windows/macOS 上会被
 * 大小写差异、8.3 短名绕过,先 rm 再 cp 同一目录会造成数据丢失。
 */
export async function sameRealPath(a: string, b: string): Promise<boolean> {
  const canonical = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));
  const [ra, rb] = await Promise.all([canonical(a), canonical(b)]);
  return ra === rb;
}

/** 从本地路径安装:复制目录入中央库 */
export async function installFromLocal(dir: string): Promise<SkillEntry> {
  const abs = path.resolve(dir);
  const { name, description } = await validateSkillDir(abs); // SKILL.md 缺失/非法时拒绝
  const id = `local:${name}`;
  const dest = path.join(libraryDir(), `local__${name}`);
  if (await sameRealPath(abs, dest)) {
    // 源即库内目录:若先 rm 再 cp 会变成自我复制(数据丢失),直接拒绝
    throw new LibraryError(`源目录已在库中,无需重复安装: ${abs}`);
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(libraryDir(), { recursive: true });
  await fs.cp(abs, dest, { recursive: true });
  const entry: SkillEntry = {
    id,
    name,
    description,
    source: { type: 'local', uri: abs },
    tags: [],
    installedAt: new Date().toISOString(),
  };
  await upsertSkill(entry);
  return entry;
}

export interface UninstallResult {
  removed: boolean;
  alsoRemoved: string[]; // 连带移除的同仓库条目 id(卸载根级 skill 会删整仓)
}

/** github 条目的仓库键("owner/repo");非 github 来源返回 null */
function githubRepoKey(entry: SkillEntry): string | null {
  if (entry.source.type !== 'github') return null;
  return entry.id.split(':')[0];
}

function githubRepoDir(repoKey: string): string {
  const [owner, repo] = repoKey.split('/');
  return path.join(libraryDir(), `github__${owner}__${repo}`);
}

/**
 * 卸载:删除库目录与注册表记录,并解除所有项目中的绑定(避免悬空引用)。
 * github 仓库级规则:卸载根级 skill 会删除整仓,同仓库其它条目连带移除;
 * 卸载子路径 skill 时,若该仓库已无其它登记条目,整仓目录一并删除。
 */
export async function uninstall(id: string): Promise<UninstallResult> {
  const entry = await getSkill(id);
  if (!entry) return { removed: false, alsoRemoved: [] };
  const registry = await readRegistry();
  const repoKey = githubRepoKey(entry);
  const repoEntries = repoKey ? registry.filter((s) => githubRepoKey(s) === repoKey) : [];
  const isRepoRoot = repoKey !== null && entry.id === `${repoKey}:`;

  const doomed = isRepoRoot ? repoEntries : [entry];
  const doomedIds = new Set(doomed.map((s) => s.id));

  if (repoKey && doomedIds.size === repoEntries.length) {
    // 整仓删除:根级 skill 的库目录即整仓;或这是该仓库最后一个登记条目
    await fs.rm(githubRepoDir(repoKey), { recursive: true, force: true });
  } else {
    await fs.rm(skillDirOf(entry), { recursive: true, force: true });
  }

  await writeRegistry(registry.filter((s) => !doomedIds.has(s.id)));
  await detachSkillFromProjects([...doomedIds]);
  return { removed: true, alsoRemoved: doomed.filter((s) => s.id !== id).map((s) => s.id) };
}

/** 更新:github 来源 git pull;local 来源重新从原路径复制 */
export async function updateSkill(id: string): Promise<SkillEntry> {
  const entry = await getSkill(id);
  if (!entry) throw new LibraryError(`skill 不存在: ${id}`);
  if (entry.source.type === 'github') {
    const { owner, repo } = normalizeGithubUri(entry.source.uri);
    const repoDir = path.join(libraryDir(), `github__${owner}__${repo}`);
    await runGit(['-C', repoDir, 'pull', '--progress', '--ff-only'], `更新 ${owner}/${repo}`);
    const { name, description } = await validateSkillDir(skillDirOf(entry));
    const next = { ...entry, name, description };
    await upsertSkill(next);
    return next;
  }
  // local:源就是库内目录时(initSkill 自建的 skill)只刷新元数据;
  // 直接走 installFromLocal 会先 rm 再 cp 同一目录,导致数据丢失
  if (await sameRealPath(entry.source.uri, skillDirOf(entry))) {
    const { name, description } = await validateSkillDir(skillDirOf(entry));
    const next = { ...entry, name, description };
    await upsertSkill(next);
    return next;
  }
  // local:从原路径重新复制
  return installFromLocal(entry.source.uri);
}

/**
 * 自建脚手架:在中央库生成一个合法 skill 并登记。
 * content 可选:用户粘贴/编辑的 SKILL.md 内容(创建界面留的"复制粘贴"入口):
 * - 带 frontmatter 的完整 SKILL.md:剥掉原 frontmatter(以校验过的 name/description 重新生成),
 *   其中 name/description 可作缺省值(显式参数优先)——贴一份现成 SKILL.md 即可零填写创建;
 * - 纯正文:直接作为正文。
 * 缺省生成引导模板。
 */
export async function initSkill(name: string, description: string, content?: string): Promise<SkillEntry> {
  let body: string | undefined;
  if (content?.trim()) {
    const fm = parseFrontmatter(content);
    if (fm) {
      name = name || fm.name || '';
      description = description || fm.description || '';
      body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^[\r\n]+/, '');
    } else {
      body = content;
    }
  }
  assertValidSkillName(name);
  if (!description) throw new LibraryError('description 不能为空(或在粘贴内容的 frontmatter 中提供)');
  const id = `local:${name}`;
  const dest = path.join(libraryDir(), `local__${name}`);
  await fs.mkdir(dest, { recursive: true });
  const skillMd = `---
name: ${name}
description: ${description}
---

${body ?? `# ${name}

${description}

## 使用说明

在这里编写该 skill 的具体指令内容。`}
`;
  await fs.writeFile(path.join(dest, 'SKILL.md'), skillMd, 'utf8');
  const entry: SkillEntry = {
    id,
    name,
    description,
    source: { type: 'local', uri: dest },
    tags: ['custom'],
    installedAt: new Date().toISOString(),
  };
  await upsertSkill(entry);
  return entry;
}

export async function listSkills(): Promise<SkillEntry[]> {
  return readRegistry();
}

export interface AdoptResult {
  adopted: SkillEntry[];                       // 新收养入库的条目
  skipped: string[];                           // 已在库中(含我们 apply 出去的 symlink),跳过
  invalid: { dir: string; reason: string }[];  // SKILL.md 缺失/非法的目录
}

/**
 * adopt 收养:把 agent skills 目录里已有的 skill 复制进中央库(local 来源,uri 记录来源路径)。
 * 方向与 apply 相反:适合把某个 agent 里攒下的 skills 收编进库,再分发给其它 agent/其它机器。
 * 幂等:指向库内的 symlink(就是我们 apply 出去的)与库中同名条目跳过;非法目录记入 invalid 不中断。
 */
export async function adoptFromAgent(
  agentId: string,
  opts: { scope: 'user' | 'project'; projectPath?: string },
): Promise<AdoptResult> {
  const adapter = getAdapter(agentId);
  if (!adapter) throw new LibraryError(`未知 agent: ${agentId}`);
  let dir: string;
  if (opts.scope === 'user') {
    dir = adapter.userSkillsDir();
  } else {
    if (!opts.projectPath) throw new LibraryError('project 作用域必须提供 projectPath');
    dir = adapter.projectSkillsDir(opts.projectPath);
  }
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!ents) throw new LibraryError(`目录不存在或不可读: ${dir}`);

  const registry = await readRegistry();
  const knownNames = new Set(registry.map((s) => s.name));
  const libRoot = await fs.realpath(libraryDir()).catch(() => libraryDir());
  const result: AdoptResult = { adopted: [], skipped: [], invalid: [] };

  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const sub = path.join(dir, ent.name);
    // 指向库内的 symlink:是我们 apply 出去的,等价于已在库中
    if (ent.isSymbolicLink()) {
      const real = await fs.realpath(sub).catch(() => '');
      if (real && real.startsWith(libRoot + path.sep)) {
        result.skipped.push(ent.name);
        continue;
      }
    }
    try {
      const { name } = await validateSkillDir(sub);
      if (knownNames.has(name)) {
        result.skipped.push(name);
        continue;
      }
      const entry = await installFromLocal(sub);
      result.adopted.push(entry);
      knownNames.add(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // installFromLocal 的"源目录已在库中"(绕过了上面 symlink 预判的写法,如 8.3 短名)按跳过处理
      if (msg.includes('已在库中')) result.skipped.push(ent.name);
      else result.invalid.push({ dir: sub, reason: msg });
    }
  }
  return result;
}
