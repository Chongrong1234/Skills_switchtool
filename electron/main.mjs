/**
 * Electron 主进程:在进程内启动 Express 服务(127.0.0.1 + 随机空闲端口),
 * 然后 BrowserWindow 加载该地址。单实例锁;窗口全关即退出(Linux 惯例)。
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
/** @type {import('node:http').Server | null} */
let server = null;

// 单实例锁:已运行则聚焦既有窗口并退出新实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

async function createWindow() {
  // 动态 import 编译产物 dist/(打包后位于 asar 内,路径相对本文件仍成立)
  const { startServer, serverPort } = await import(
    pathToFileURL(path.join(__dirname, '..', 'dist', 'serve.js')).href
  );
  server = await startServer(0, '127.0.0.1');
  const port = serverPort(server);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f1115', // 与前端深色主题一致
    title: 'Skills SwitchTool',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});
