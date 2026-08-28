/**
 * 入口(web 模式):启动 HTTP 服务(REST API + public/ 单页应用)。
 * 端口默认 5174,可用 PORT 环境变量覆盖。
 */
import { startServer, serverPort } from './serve.js';

const port = Number(process.env.PORT || 5174);

const server = await startServer(port);
console.log(`Skills SwitchTool 已启动: http://localhost:${serverPort(server)}`);
