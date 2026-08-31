/**
 * 软件更新:对照 GitHub Releases 的最新版本,提示/下载/自动获取新安装包。
 *
 * 设计决策:
 * - 不引 electron-updater 之类的依赖(项目约定:不轻易新增运行时依赖)。这里的"更新"=
 *   检查最新 release → 下载匹配当前平台的安装包到 <SSW_HOME>/downloads/ → 打开目录由用户
 *   替换/安装(AppImage 直接替换;NSIS 跑安装向导;dmg 拖入 Applications)。
 * - 版本对照只看 release tag 的 X.Y.Z 数字段(compareVersions);当前版本取 src/version.ts。
 * - 检查结果缓存 6h(cache/update-latest.json);手动「检查更新」强制刷新;并发调用共享
 *   同一次在途请求(桌面 App 启动自检与 GUI 手动检查不重复打 API)。
 * - 与 recommend/ai 同一约定:任何网络/解析失败都降级为 { ok:false, message },绝不抛异常
 *   (UpdateError 只用于配置校验/打开器这类用户输入或本地操作错误,由上层映射 400)。
 * - 下载进度写内存表(listUpdateProgress),server 把它合并进 GET /api/progress,
 *   GUI 进度条零改动复用;下载目录不在 ensureSkeleton 里建,真正下载时才创建。
 * - API 基址可用 SSW_UPDATE_API 覆盖(测试注入本地服务);资产 URL 只接受 https。
 * CLI(ssw update)/ REST(/api/update/*)/ 桌面 GUI(设置弹窗+侧栏横幅)/ TUI(U 键)共用本模块。
 */
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { cacheDir, downloadsDir, updateFile } from './paths.js';
import { atomicWriteJson, readJsonSafe, renameWithRetry } from './registry.js';
import { VERSION } from '../version.js';

export class UpdateError extends Error {}

/** 自动更新配置(update.json;字段级容错读、原子写) */
export interface UpdateConfig {
  autoCheck: boolean;    // 启动时自动检查更新(桌面 App;默认开)
  autoDownload: boolean; // 发现新版本时自动下载安装包(默认关,下载有流量代价)
}

const DEFAULT_CONFIG: UpdateConfig = { autoCheck: true, autoDownload: false };

export async function readUpdateConfig(): Promise<UpdateConfig> {
  const data = await readJsonSafe<Partial<UpdateConfig>>(updateFile(), {});
  return {
    autoCheck: typeof data.autoCheck === 'boolean' ? data.autoCheck : DEFAULT_CONFIG.autoCheck,
    autoDownload: typeof data.autoDownload === 'boolean' ? data.autoDownload : DEFAULT_CONFIG.autoDownload,
  };
}

/** 更新配置:undefined = 保持不变;非布尔值抛 UpdateError(上层映射 400) */
export async function saveUpdateConfig(patch: Partial<UpdateConfig>): Promise<UpdateConfig> {
  const cur = await readUpdateConfig();
  const next: UpdateConfig = { ...cur };
  for (const k of ['autoCheck', 'autoDownload'] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new UpdateError(`${k} 必须是布尔值`);
    next[k] = v;
  }
  await atomicWriteJson(updateFile(), next);
  return next;
}

/** 检查源:默认 GitHub API;SSW_UPDATE_API 覆盖(测试注入本地服务用) */
function updateApiUrl(): string {
  return (
    process.env.SSW_UPDATE_API ||
    'https://api.github.com/repos/Chongrong1234/Skills_switchtool/releases/latest'
  );
}

/** 检查请求超时(默认 30s,SSW_UPDATE_TIMEOUT_MS 覆盖;与 SSW_GIT_TIMEOUT_MS 同一约定) */
function updateTimeoutMs(): number {
  const v = Number(process.env.SSW_UPDATE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

/** 解析版本号的 X.Y.Z 数字段;容忍 v 前缀与后缀(1.5.0-beta → [1,5,0]);解析不了返回 null */
function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * 版本比较:a 新返回正数,b 新返回负数,相等 0。
 * 解析不了的一侧按"更旧"处理(开发构建能看到更新;坏 tag 不会误报有新版本)。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export interface ReleaseAsset {
  name: string;
  url: string; // browser_download_url(只接受 https)
  size: number; // 字节
}

export interface ReleaseInfo {
  tag: string;
  version: string; // 去 v 前缀
  releaseUrl: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
  ok: boolean; // false = 网络/解析失败(降级,message 带原因)
  current: string;
  checkedAt: string;
  cached?: boolean; // 命中磁盘缓存(未发请求)
  latest?: string;
  tag?: string;
  releaseUrl?: string;
  publishedAt?: string;
  hasUpdate?: boolean;
  asset?: ReleaseAsset | null; // 匹配当前平台的安装包(无更新或无匹配时为 null)
  message?: string;
}

/**
 * 从 release 资产里挑当前平台的安装包:
 * Windows → Setup*.exe;macOS → 按 arch 匹配 arm64/非 arm64 dmg,兜底任意 dmg;Linux → AppImage。
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
  if (platform === 'win32') {
    return (
      assets.find((a) => /setup.*\.exe$/i.test(a.name)) ??
      assets.find((a) => /\.exe$/i.test(a.name)) ??
      null
    );
  }
  if (platform === 'darwin') {
    // GitHub 资产按名字排序,arm64 的 dmg 排在 x64 前面('-' < '.'),
    // 不能简单取第一个 dmg:按 arch 精确匹配,落空再兜底任意 dmg
    const dmgs = assets.filter((a) => /\.dmg$/i.test(a.name));
    if (arch === 'arm64') {
      return dmgs.find((a) => /arm64/i.test(a.name)) ?? dmgs[0] ?? null;
    }
    return dmgs.find((a) => !/arm64/i.test(a.name)) ?? dmgs[0] ?? null;
  }
  if (platform === 'linux') {
    return assets.find((a) => /\.appimage$/i.test(a.name)) ?? null;
  }
  return null;
}

type FetchLike = typeof fetch;

async function fetchLatestRelease(fetchImpl: FetchLike): Promise<ReleaseInfo> {
  const res = await fetchImpl(updateApiUrl(), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'skills-switchtool' },
    signal: AbortSignal.timeout(updateTimeoutMs()),
  });
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  const data = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };
  if (typeof data.tag_name !== 'string' || !data.tag_name) {
    throw new Error('Release 数据缺少 tag_name');
  }
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(data.assets)) {
    for (const a of data.assets) {
      if (!a || typeof a !== 'object') continue;
      const { name, browser_download_url: url, size } = a as Record<string, unknown>;
      // 只收 https 资产:下载器不验证 URL 之外的任何东西,这里收紧输入面
      if (typeof name === 'string' && typeof url === 'string' && url.startsWith('https://')) {
        assets.push({ name, url, size: typeof size === 'number' ? size : 0 });
      }
    }
  }
  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^v/, ''),
    releaseUrl: typeof data.html_url === 'string' ? data.html_url : '',
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
    assets,
  };
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 检查缓存 6h:比推荐库的 24h 短,发版后更快被看到

function cacheFilePath(): string {
  return path.join(cacheDir(), 'update-latest.json');
}

async function readReleaseCache(): Promise<ReleaseInfo | null> {
  try {
    const st = await fs.stat(cacheFilePath());
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    const data = await readJsonSafe<{ release?: ReleaseInfo }>(cacheFilePath(), {});
    return data.release && typeof data.release.tag === 'string' ? data.release : null;
  } catch {
    return null;
  }
}

async function writeReleaseCache(release: ReleaseInfo): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cacheFilePath(), JSON.stringify({ release }), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

let inflight: Promise<UpdateCheckResult> | null = null; // 在途请求(并发去重)
let lastResult: UpdateCheckResult | null = null; // 本进程最近一次结果(GUI 启动横幅数据源)

/** 本进程最近一次检查结果(未检查过返回 null);GUI 横幅/状态接口用,不发网络请求 */
export function getLastUpdateCheck(): UpdateCheckResult | null {
  return lastResult;
}

/**
 * 检查更新:默认先读 6h 磁盘缓存,缓存过期才打 GitHub API;force 跳过缓存。
 * 并发调用共享同一次在途请求。任何失败降级为 { ok:false, message },不抛异常。
 */
export function checkForUpdate(
  opts: { force?: boolean; fetchImpl?: FetchLike; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<UpdateCheckResult> {
  if (inflight) return inflight;
  const p = doCheck(opts).finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

async function doCheck(opts: {
  force?: boolean;
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<UpdateCheckResult> {
  const current = VERSION;
  const checkedAt = new Date().toISOString();
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  try {
    let release: ReleaseInfo | null = null;
    let cached = false;
    if (!opts.force) {
      release = await readReleaseCache();
      cached = release !== null;
    }
    if (!release) {
      release = await fetchLatestRelease(opts.fetchImpl ?? fetch);
      await writeReleaseCache(release);
    }
    const hasUpdate = compareVersions(release.version, current) > 0;
    const result: UpdateCheckResult = {
      ok: true,
      current,
      checkedAt,
      cached,
      latest: release.version,
      tag: release.tag,
      releaseUrl: release.releaseUrl,
      publishedAt: release.publishedAt,
      hasUpdate,
      asset: hasUpdate ? pickAsset(release.assets, platform, arch) : null,
    };
    lastResult = result;
    return result;
  } catch (err) {
    const result: UpdateCheckResult = {
      ok: false,
      current,
      checkedAt,
      message: `检查更新失败(已降级): ${err instanceof Error ? err.message : String(err)}`,
    };
    lastResult = result;
    return result;
  }
}

/** 更新下载任务进度(同一时刻最多一个;done 后保留供 GUI 展示"已下载:路径") */
export interface UpdateDownloadJob {
  label: string; // 资产文件名
  transferred: number;
  total: number; // 0 = 服务端没给 content-length
  pct: number | null;
  text: string; // 人类可读进度("12.3 MB / 119.2 MB")
  done: boolean;
  error?: string;
  file?: string; // 完成后的落盘路径
  updatedAt: number;
}

let downloadJob: UpdateDownloadJob | null = null;

/** 当前/最近一次下载任务(无则 null);GET /api/update/status 与 /api/progress 合并用 */
export function getUpdateDownload(): UpdateDownloadJob | null {
  return downloadJob;
}

/** 兼容 git 进度条形状的结构,server 把它合并进 GET /api/progress(GUI 进度条零改动复用) */
export function listUpdateProgress(): { label: string; phase: string | null; pct: number | null; text: string; updatedAt: number }[] {
  if (!downloadJob || downloadJob.done) return [];
  return [
    {
      label: `下载更新 ${downloadJob.label}`,
      phase: null,
      pct: downloadJob.pct,
      text: downloadJob.text,
      updatedAt: downloadJob.updatedAt,
    },
  ];
}

function touchJob(patch: Partial<UpdateDownloadJob>): void {
  if (downloadJob) Object.assign(downloadJob, patch, { updatedAt: Date.now() });
}

/**
 * 下载安装包到 <SSW_HOME>/downloads/(流式写盘,先进 .part 再改名,不留半截文件)。
 * 进行中重复调用抛 UpdateError;下载失败清理 .part 并把错误记进 job.error 后再抛。
 */
export async function downloadUpdate(
  asset: ReleaseAsset,
  fetchImpl: FetchLike = fetch,
): Promise<{ file: string }> {
  if (!asset.url.startsWith('https://')) throw new UpdateError('资产 URL 必须是 https');
  if (downloadJob && !downloadJob.done) throw new UpdateError('已有下载任务进行中');
  downloadJob = {
    label: asset.name,
    transferred: 0,
    total: asset.size || 0,
    pct: asset.size ? 0 : null,
    text: '连接中…',
    done: false,
    updatedAt: Date.now(),
  };
  const dir = downloadsDir();
  const file = path.join(dir, asset.name);
  const tmp = `${file}.part`;
  try {
    await fs.mkdir(dir, { recursive: true });
    const res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'skills-switchtool' } });
    if (!res.ok) throw new Error(`下载失败:HTTP ${res.status}`);
    if (!res.body) throw new Error('下载失败:响应无 body');
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    touchJob({ total, pct: total ? 0 : null });
    const stream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    const outStream = fsSync.createWriteStream(tmp);
    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        const transferred = (downloadJob!.transferred += buf.length);
        touchJob({
          transferred,
          pct: total ? Math.min(99, Math.floor((transferred / total) * 100)) : null,
          text: total
            ? `${(transferred / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB`
            : `${(transferred / 1048576).toFixed(1)} MB`,
        });
        if (!outStream.write(buf)) {
          await new Promise<void>((resolve, reject) => {
            outStream.once('drain', resolve);
            outStream.once('error', reject);
          });
        }
      }
    } finally {
      await new Promise<void>((resolve) => outStream.end(resolve));
    }
    await renameWithRetry(tmp, file);
    // AppImage 需要可执行位才能直接运行(Windows 上 chmod 无意义,静默跳过)
    await fs.chmod(file, 0o755).catch(() => {});
    touchJob({ done: true, pct: 100, file, text: '下载完成' });
    return { file };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    touchJob({ done: true, error: err instanceof Error ? err.message : String(err), text: '下载失败' });
    throw err;
  }
}

/**
 * 用系统默认程序打开 https URL 或绝对路径(发布页/下载目录)。
 * 只接受这两类输入,不给"任意协议打开器"留口子;detached 子进程,不等待其退出。
 */
export async function openExternal(target: string): Promise<void> {
  if (!/^https:\/\//.test(target) && !path.isAbsolute(target)) {
    throw new UpdateError('只允许打开 https URL 或绝对路径');
  }
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => reject(new UpdateError(`无法打开(缺少 ${cmd}?): ${err.message}`)));
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * 桌面 App 启动时的自动更新流程(serve.ts 在 listen 后 fire-and-forget 调用):
 * 配置了自动检查才发请求;发现新版本且开了自动下载则后台下载。一切失败静默,不影响启动。
 */
export async function autoUpdateOnStartup(fetchImpl?: FetchLike): Promise<UpdateCheckResult | null> {
  try {
    const cfg = await readUpdateConfig();
    if (!cfg.autoCheck) return null;
    const r = await checkForUpdate({ fetchImpl });
    if (r.ok && r.hasUpdate && r.asset && cfg.autoDownload) {
      // 下载失败只落在 download job 的 error 字段,GUI 轮询可见;不影响启动
      await downloadUpdate(r.asset, fetchImpl).catch(() => {});
    }
    return r;
  } catch {
    return null;
  }
}
