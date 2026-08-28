/**
 * 可复用的服务启动函数:确保目录骨架存在 + app.listen。
 * web 模式(src/index.ts)与 Electron 主进程(electron/main.mjs)共用。
 */
import type { Server } from 'node:http';
import { ensureSkeleton } from './core/paths.js';
import { createApp } from './server.js';

/**
 * 启动 HTTP 服务。
 * @param port 端口;传 0 表示随机空闲端口(桌面模式用)
 * @param host 绑定地址;桌面模式传 127.0.0.1 仅监听本机回环
 */
export async function startServer(port: number, host?: string): Promise<Server> {
  await ensureSkeleton();
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
