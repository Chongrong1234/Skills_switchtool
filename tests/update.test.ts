/**
 * update 软件更新测试:版本比较 / 平台资产挑选 / 配置读写容错 / 检查(假 fetch + 6h 缓存)/
 * 下载落盘与并发拒绝 / 打开器输入校验 / 启动自动更新流程。
 * SSW_HOME 隔离到临时目录;网络一律注入假 fetch,不打真实 GitHub。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadsDir, updateFile } from '../src/core/paths.js';
import {
  autoUpdateOnStartup,
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  getUpdateDownload,
  openExternal,
  pickAsset,
  readUpdateConfig,
  saveUpdateConfig,
  UpdateError,
  type ReleaseAsset,
} from '../src/core/update.js';
import { VERSION } from '../src/version.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-update-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

/** 造一份"远超当前版本"的假 release(资产覆盖三平台) */
function fakeRelease(tag = 'v99.0.0') {
  const version = tag.replace(/^v/, '');
  const base = `https://github.com/Chongrong1234/Skills_switchtool/releases/download/${tag}`;
  return {
    tag_name: tag,
    html_url: `https://github.com/Chongrong1234/Skills_switchtool/releases/tag/${tag}`,
    published_at: '2026-09-01T00:00:00Z',
    assets: [
      { name: `Skills.SwitchTool-${version}.AppImage`, browser_download_url: `${base}/x.AppImage`, size: 125000000 },
      { name: `Skills.SwitchTool-Setup-${version}.exe`, browser_download_url: `${base}/setup.exe`, size: 90000000 },
      { name: `Skills.SwitchTool-${version}-arm64.dmg`, browser_download_url: `${base}/arm64.dmg`, size: 95000000 },
      { name: `Skills.SwitchTool-${version}.dmg`, browser_download_url: `${base}/x64.dmg`, size: 94000000 },
    ],
  };
}

function jsonFetch(payload: unknown, calls?: { n: number }): typeof fetch {
  return (async () => {
    if (calls) calls.n++;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

describe('compareVersions', () => {
  it('按 X.Y.Z 数字段比较;容忍 v 前缀与后缀;解析不了的一侧按更旧处理', () => {
    expect(compareVersions('1.5.0', '1.4.10')).toBeGreaterThan(0); // 次版本优先于补丁位
    expect(compareVersions('1.4.10', '1.5.0')).toBeLessThan(0);
    expect(compareVersions('1.4.10', '1.4.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.4.10', '1.4.10')).toBe(0);
    expect(compareVersions('1.5.0-beta', '1.5.0')).toBe(0);
    expect(compareVersions('dev-build', '1.0.0')).toBeLessThan(0); // 开发构建能看到更新
    expect(compareVersions('1.0.0', 'dev-build')).toBeGreaterThan(0); // 坏 tag 不误报
    expect(compareVersions('x', 'y')).toBe(0);
  });
});

describe('pickAsset', () => {
  const assets: ReleaseAsset[] = [
    { name: 'Skills.SwitchTool-1.5.0-arm64.dmg', url: 'https://x/arm64.dmg', size: 1 },
    { name: 'Skills.SwitchTool-1.5.0.AppImage', url: 'https://x/a', size: 1 },
    { name: 'Skills.SwitchTool-Setup-1.5.0.exe', url: 'https://x/s', size: 1 },
    { name: 'Skills.SwitchTool-1.5.0.dmg', url: 'https://x/d', size: 1 },
  ];

  it('linux → AppImage;win32 → Setup*.exe 优先、兜底任意 exe;darwin 按 arch 精确匹配', () => {
    expect(pickAsset(assets, 'linux', 'x64')?.name).toContain('AppImage');
    expect(pickAsset(assets, 'win32', 'x64')?.name).toContain('Setup');
    // arm64 dmg 排在前面(模拟 GitHub 字母序)也不能被 x64 挑走
    expect(pickAsset(assets, 'darwin', 'x64')?.name).toBe('Skills.SwitchTool-1.5.0.dmg');
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe('Skills.SwitchTool-1.5.0-arm64.dmg');
  });

  it('兜底与空集:无 Setup 时任意 exe;无匹配平台资产返回 null', () => {
    const noSetup = assets.filter((a) => !/setup/i.test(a.name));
    expect(pickAsset(noSetup, 'win32', 'x64')).toBeNull(); // 一个 exe 都没有
    const plainExe: ReleaseAsset[] = [{ name: 'tool-1.5.0.exe', url: 'https://x/e', size: 1 }];
    expect(pickAsset(plainExe, 'win32', 'x64')?.name).toBe('tool-1.5.0.exe');
    // arm64 机器上没有 arm64 dmg 时兜底任意 dmg
    const x64Only = assets.filter((a) => !/arm64/i.test(a.name));
    expect(pickAsset(x64Only, 'darwin', 'arm64')?.name).toBe('Skills.SwitchTool-1.5.0.dmg');
    expect(pickAsset([], 'linux', 'x64')).toBeNull();
  });
});

describe('更新配置(update.json)', () => {
  it('默认 autoCheck 开、autoDownload 关;损坏文件容错回默认', async () => {
    expect(await readUpdateConfig()).toEqual({ autoCheck: true, autoDownload: false });
    await fs.writeFile(updateFile(), '{oops', 'utf8');
    expect(await readUpdateConfig()).toEqual({ autoCheck: true, autoDownload: false });
  });

  it('saveUpdateConfig:部分更新持久化;非布尔值抛 UpdateError', async () => {
    const c = await saveUpdateConfig({ autoDownload: true });
    expect(c).toEqual({ autoCheck: true, autoDownload: true });
    expect(JSON.parse(await fs.readFile(updateFile(), 'utf8'))).toEqual(c);
    expect(await readUpdateConfig()).toEqual(c); // 读回
    await expect(
      saveUpdateConfig({ autoCheck: 'yes' as unknown as boolean }),
    ).rejects.toThrow(UpdateError);
  });
});

describe('checkForUpdate', () => {
  it('发现新版本:hasUpdate、按注入平台挑资产、当前版本取 VERSION', async () => {
    const r = await checkForUpdate({ fetchImpl: jsonFetch(fakeRelease()), platform: 'linux', arch: 'x64' });
    expect(r.ok).toBe(true);
    expect(r.hasUpdate).toBe(true);
    expect(r.current).toBe(VERSION);
    expect(r.latest).toBe('99.0.0');
    expect(r.tag).toBe('v99.0.0');
    expect(r.releaseUrl).toContain('/releases/tag/v99.0.0');
    expect(r.asset?.name).toBe('Skills.SwitchTool-99.0.0.AppImage');

    const win = await checkForUpdate({ force: true, fetchImpl: jsonFetch(fakeRelease()), platform: 'win32', arch: 'x64' });
    expect(win.asset?.name).toContain('Setup');
  });

  it('同版本/更旧版本:无更新、asset 为 null', async () => {
    const same = await checkForUpdate({ fetchImpl: jsonFetch(fakeRelease(`v${VERSION}`)) });
    expect(same.ok).toBe(true);
    expect(same.hasUpdate).toBe(false);
    expect(same.asset).toBeNull();

    const older = await checkForUpdate({ force: true, fetchImpl: jsonFetch(fakeRelease('v0.0.1')) });
    expect(older.hasUpdate).toBe(false);
  });

  it('失败降级:HTTP 非 200 / fetch 抛错 / 缺 tag_name 都 ok:false 不抛出', async () => {
    const http404 = await checkForUpdate({ fetchImpl: (async () => new Response('x', { status: 404 })) as typeof fetch });
    expect(http404.ok).toBe(false);
    expect(http404.message).toContain('404');

    const boom = await checkForUpdate({
      force: true,
      fetchImpl: (async () => { throw new Error('网络不可达'); }) as typeof fetch,
    });
    expect(boom.ok).toBe(false);
    expect(boom.message).toContain('网络不可达');

    const noTag = await checkForUpdate({ force: true, fetchImpl: jsonFetch({}) });
    expect(noTag.ok).toBe(false);
    expect(noTag.message).toContain('tag_name');
  });

  it('6h 磁盘缓存:第二次不发请求(cached:true);force 强制刷新', async () => {
    const calls = { n: 0 };
    const f = jsonFetch(fakeRelease(), calls);
    const r1 = await checkForUpdate({ fetchImpl: f });
    expect(r1.cached).toBe(false);
    const r2 = await checkForUpdate({ fetchImpl: f });
    expect(r2.cached).toBe(true);
    expect(calls.n).toBe(1);
    const r3 = await checkForUpdate({ fetchImpl: f, force: true });
    expect(r3.cached).toBe(false);
    expect(calls.n).toBe(2);
  });
});

describe('downloadUpdate', () => {
  const asset: ReleaseAsset = { name: 'Skills.SwitchTool-99.0.0.AppImage', url: 'https://fake.test/x.AppImage', size: 19 };

  it('流式落盘到 downloads/(.part 改名),job 完成态带文件路径', async () => {
    const content = Buffer.from('fake-appimage-bin');
    const fetchImpl = (async () =>
      new Response(content, { status: 200, headers: { 'content-length': String(content.length) } })) as typeof fetch;
    const { file } = await downloadUpdate(asset, fetchImpl);
    expect(file).toBe(path.join(downloadsDir(), asset.name));
    expect(await fs.readFile(file)).toEqual(content);
    // .part 已改名,不残留
    await expect(fs.stat(`${file}.part`)).rejects.toThrow();
    const job = getUpdateDownload();
    expect(job?.done).toBe(true);
    expect(job?.file).toBe(file);
    expect(job?.error).toBeUndefined();
    expect(job?.pct).toBe(100);
  });

  it('在途任务拒绝并发;结束后可再次下载', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        c.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const fetchImpl = (async () => new Response(slow)) as typeof fetch;
    // async 函数体同步执行到首个 await:调用后 job 立即注册
    const p = downloadUpdate(asset, fetchImpl);
    expect(getUpdateDownload()?.done).toBe(false);
    await expect(downloadUpdate(asset, fetchImpl)).rejects.toThrow('已有下载任务进行中');
    ctrl.close();
    await p;
    expect(getUpdateDownload()?.done).toBe(true);
    // done 后不再视为在途,可再次发起
    const again = await downloadUpdate(asset, (async () => new Response('x')) as typeof fetch);
    expect(again.file).toBe(path.join(downloadsDir(), asset.name));
  });

  it('非 https 资产直接拒绝(不注册 job 之外的任何副作用)', async () => {
    await expect(
      downloadUpdate({ name: 'x', url: 'http://fake.test/x', size: 1 }, (async () => new Response('x')) as typeof fetch),
    ).rejects.toThrow(UpdateError);
  });

  it('HTTP 失败:清理 .part、错误记进 job.error 后再抛', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(downloadUpdate({ name: 'bad.bin', url: 'https://fake.test/bad', size: 3 }, fetchImpl)).rejects.toThrow('404');
    const job = getUpdateDownload();
    expect(job?.done).toBe(true);
    expect(job?.error).toContain('404');
    await expect(fs.stat(path.join(downloadsDir(), 'bad.bin.part'))).rejects.toThrow();
  });
});

describe('openExternal 输入校验', () => {
  it('只接受 https URL 或绝对路径;其余一律 UpdateError(不 spawn)', async () => {
    await expect(openExternal('http://example.com/x')).rejects.toThrow(UpdateError);
    await expect(openExternal('relative/path')).rejects.toThrow(UpdateError);
    await expect(openExternal('javascript:alert(1)')).rejects.toThrow(UpdateError);
    // 成功路径会 spawn 系统打开器(xdg-open/open),CI 未必有,不在此断言
  });
});

describe('autoUpdateOnStartup', () => {
  it('autoCheck 关时完全不发请求,返回 null', async () => {
    await saveUpdateConfig({ autoCheck: false });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    expect(await autoUpdateOnStartup(fetchImpl)).toBeNull();
    expect(called).toBe(false);
  });

  it('autoCheck 开:返回检查结果;autoDownload 开且有更新时后台下载安装包', async () => {
    await saveUpdateConfig({ autoCheck: true, autoDownload: true });
    const content = Buffer.from('auto-dl');
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('.AppImage')) {
        return new Response(content, { headers: { 'content-length': String(content.length) } });
      }
      return new Response(JSON.stringify(fakeRelease()), { status: 200 });
    }) as typeof fetch;
    const r = await autoUpdateOnStartup(fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.hasUpdate).toBe(true);
    // 自动下载已落盘
    const job = getUpdateDownload();
    expect(job?.done).toBe(true);
    expect(await fs.readFile(job!.file!)).toEqual(content);
  });
});
