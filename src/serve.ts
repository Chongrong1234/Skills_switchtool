/**
 * 可复用的服务启动函数:确保目录骨架存在 + app.listen。
 * 供 Electron 主进程(electron/main.mjs)进程内启动,窗口加载该本机地址。
 * 启动时自动把本机各 agent 用户级 skills 目录里已有的 skills 收养进中央库(幂等、只读源目录),
 * 让用户打开 App 就能在技能库看到本机已配置的 skills;失败静默降级,不影响服务启动。
 */
import type { Server } from 'node:http';
import { adoptFromAllAgents } from './core/library.js';
import { ensureSkeleton } from './core/paths.js';
import { createApp } from './server.js';

/**
 * 启动 HTTP 服务。
 * @param port 端口;传 0 表示随机空闲端口(桌面模式用)
 * @param host 绑定地址;桌面模式传 127.0.0.1 仅监听本机回环
 */
export async function startServer(port: number, host?: string): Promise<Server> {
  await ensureSkeleton();
  // 启动即自动收养(在 listen 前 await,保证窗口首次加载的列表已含本机 skills;
  // 本地磁盘操作很快,幂等时近乎零开销)
  try {
    await adoptFromAllAgents({ scope: 'user' });
  } catch {
    /* 静默降级:收养失败不影响服务启动 */
  }
  const app = createApp();
  return new Promise((resolve, reject) => {
    // express 的 listen 重载不接受 undefined 的 hostname,按有无 host 分开调用
    let server: Server;
    const onReady = () => resolve(server);
    server = host ? app.listen(port, host, onReady) : app.listen(port, onReady);
    server.on('error', reject);
  });
}

/** 取服务实际监听端口(listen(0) 后查询) */
export function serverPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr !== null ? addr.port : 0;
}
