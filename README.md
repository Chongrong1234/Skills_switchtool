# Skills SwitchTool

**项目中心化的 Agent Skills 管理工具(Web GUI)**:创建项目(绑定目录)→ 为项目勾选 skills 集合和目标 agents → 一键 apply 写入各 agent 的项目级 skills 目录 → 一键切换项目,技能集跟着走。支持从 GitHub / 本地路径安装 skills、用户自建 skill 脚手架,创建项目时自动推荐 GitHub 高 star skills。

交互模式仿照 [cc-switch](https://github.com/farion1231/cc-switch):**中央存储 + GUI 切换 + 写入目标工具配置位置 + 备份可回滚**。

## 安装与启动

```bash
npm install        # 安装依赖(运行时依赖仅 express + commander)
npm run dev        # 开发模式启动(tsx),默认 http://localhost:5174
npm run build      # tsc 编译到 dist/
npm start          # 运行编译产物
npm test           # vitest 全量测试
```

端口可用环境变量覆盖:`PORT=8080 npm run dev`。
数据根目录默认 `~/.skills-switch/`,可用 `SSW_HOME` 环境变量覆盖(测试隔离用)。

## 桌面 App(Electron)

后端 Express 服务在 Electron 主进程内**进程内运行**(`electron/main.mjs` import 编译产物 `dist/serve.js`,监听 `127.0.0.1` + 随机空闲端口),不依赖外部 node 进程;窗口加载该本机地址。单实例锁,窗口全关即退出。

```bash
npm run app    # 开发运行:先 tsc 编译,再 electron . 起桌面窗口(需图形环境)
npm run dist   # 打包:编译 + electron-builder,产出 Linux AppImage 到 release/
```

产物:`release/Skills SwitchTool-<版本>.AppImage`。

AppImage 用法:

```bash
chmod +x "release/Skills SwitchTool-"*.AppImage
./release/Skills\ SwitchTool-*.AppImage        # 命令行运行;也可文件管理器中双击
```

注意:在容器/受限环境(或部分无内核沙箱支持的系统)中 Electron 可能需要 `--no-sandbox` 才能启动:
`./Skills\ SwitchTool-*.AppImage --no-sandbox`。

图标 `build/icon.png` 由脚本生成(纯 Node 手写 PNG):`node scripts/make-icon.mjs`。

## CLI(服务器版)

`ssw` 是纯命令行、非交互的 CLI,适合无 GUI 的服务器环境。子命令完整映射 core 能力:

```bash
ssw agents                              # 各 agent 适配器及 detected 状态
ssw project list                        # 项目列表,* 为当前激活项
ssw project create --name X --path /abs/path --agents claude-code,kimi-code --mode symlink|copy
ssw project show <id|name>              # 详情:agents、技能集、上次 apply 时间
ssw project switch <id|name>            # 设为当前项目并 apply
ssw project apply [id|name]             # 省略时用当前激活项目
ssw project unapply [id|name]
ssw project rollback [id|name]
ssw project remove <id|name>            # 只删档案,不动磁盘文件
ssw project bind <id|name> <skillId...> # 设置项目技能集(整体替换)
ssw skill list
ssw skill add --github <owner/repo 或 URL>
ssw skill add --local /path/to/skill
ssw skill init --name X --desc "..."    # 自建 skill 脚手架
ssw skill remove <id>
ssw skill update [id]                   # 省略 id 更新全部 github 来源
ssw recommend --path /abs/path [--keywords a,b,c]
ssw serve [--port 5174]                 # 服务器上也可顺手起 Web GUI
```

约定:

- **id|name 寻址**:先精确匹配 id,再匹配 name;name 歧义时报错并列出候选;找不到退出码非零
- **全局 `--json`**:所有输出可切为 JSON(如 `ssw project list --json`),方便脚本化
- 错误信息打 stderr、退出码非零;成功输出打 stdout;缺必填参数时报错并打印该命令用法
- 数据目录与 GUI/桌面版共用 `~/.skills-switch/`(可用 `SSW_HOME` 覆盖),即三种前端共享同一份状态

本机使用:`npm run build` 后 `node dist/cli.js ...`(package.json 已注册 `bin: ssw`,`npm link` 后可直接 `ssw ...`)。

### 单文件分发(拷到服务器即用)

```bash
npm run dist:cli     # 产出 release/cli/ssw.mjs(esbuild 打包,零依赖)
```

把 `ssw.mjs` 拷到任意有 **Node ≥ 18** 的服务器:

```bash
chmod +x ssw.mjs
./ssw.mjs agents                       # 或 node ssw.mjs agents
```

典型服务器工作流:

```bash
export SSW_HOME=/data/skills-switch    # 数据目录(可选,默认 ~/.skills-switch)
./ssw.mjs skill init --name deploy-notes --desc "部署笔记规范"
./ssw.mjs project create --name api --path /srv/api --agents claude-code --mode symlink
./ssw.mjs project bind api local:deploy-notes
./ssw.mjs project switch api           # 激活并写入 /srv/api/.claude/skills/
./ssw.mjs recommend --path /srv/api --keywords api,express --json
./ssw.mjs serve --port 5174            # 需要时顺手起 Web GUI
```

## 目录结构

```
src/
  core/
    paths.ts      # ~/.skills-switch/ 路径常量(library/ registry.json projects.json snapshots/ cache/)
    types.ts      # SkillEntry、Project 等类型(与 PLAN.md 4.3 一致)
    registry.ts   # skills 注册表读写(原子写: tmp+rename;损坏 JSON 容错)
    library.ts    # 安装(github→git clone --depth 1 / local→复制)、卸载、更新、initSkill 脚手架
    projects.ts   # 项目 CRUD + activeProjectId 管理
    apply.ts      # apply/unapply:技能集物化到各 agent 项目级目录;symlink 默认、copy 可选、冲突移入快照
    snapshot.ts   # apply 前快照,rollback 还原;每项目保留最近 5 份
    recommend.ts  # 技术栈检测 + GitHub Search API 按 star 排序;24h 缓存;断网/限流降级不抛异常
  adapters/
    types.ts      # AgentAdapter 接口(PLAN.md 4.4)
    claude-code.ts kimi-code.ts cursor.ts codex.ts
    index.ts      # 适配器注册表
  server.ts       # Express 应用(API + 托管 public/)
  serve.ts        # startServer(port, host?):可复用启动函数(web / Electron / CLI serve 共用)
  cli.ts          # ssw 命令行入口(commander,全子命令 + --json)
  index.ts        # web 模式入口:listen(默认 5174,PORT 覆盖)
electron/
  main.mjs        # Electron 主进程:in-process 起服务(127.0.0.1+随机端口)+ BrowserWindow
public/           # 原生 HTML/CSS/JS 单页应用(无构建步骤)
scripts/
  make-icon.mjs   # 生成 build/icon.png(纯 Node 手写 PNG)
  build-cli.mjs   # esbuild 打包 CLI 单文件 release/cli/ssw.mjs(注入 createRequire)
tests/            # vitest,SSW_HOME 指向 mkdtemp 临时目录隔离,不碰真实 ~/.skills-switch
electron-builder.yml  # 打包配置:Linux AppImage → release/
```

## API 列表(REST,JSON;错误统一 `{ "error": "..." }`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agents` | 各适配器 `{id, displayName, detected, capabilities}` |
| GET | `/api/projects` | `{ activeProjectId, projects }` |
| POST | `/api/projects` | 创建 `{name, path, agents[], applyMode}` |
| GET / PATCH / DELETE | `/api/projects/:id` | 查 / 改(name、agents、skills、applyMode)/ 删 |
| POST | `/api/projects/:id/switch` | 设为当前项目并 apply |
| POST | `/api/projects/:id/apply` | 应用技能集到各 agent 目录 |
| POST | `/api/projects/:id/unapply` | 移除该项目的物化结果 |
| POST | `/api/projects/:id/rollback` | 回滚最近一次 apply 快照 |
| POST | `/api/projects/:id/skills` | 绑定技能集 `{skillIds: [...]}` |
| GET | `/api/skills` | 中央库全部 skills |
| POST | `/api/skills` | 安装 `{source: 'github'\|'local', uri}` |
| DELETE | `/api/skills/:id` | 卸载(id 需 encodeURIComponent) |
| POST | `/api/skills/init` | 自建脚手架 `{name, description}` |
| GET | `/api/recommend?projectId=xx` | 技术栈 + 项目名关键词推荐,Top 10 |

## 与 cc-switch 的对应关系

| cc-switch | Skills SwitchTool |
|---|---|
| 中央存储各供应商配置 | 中央库 `~/.skills-switch/library/` 存放全部 skills(唯一事实来源) |
| GUI 中切换当前供应商 | GUI 中切换当前项目(switch) |
| 切换时写入 Claude Code 的 settings.json | apply 时写入各 agent 的项目级 skills 目录(`.claude/skills`、`.kimi-code/skills`、`.cursor/skills`、`.codex/skills`) |
| 写前备份、可回滚 | apply 前快照(`snapshots/<projectId>/`,保留最近 5 份),一键 rollback |
| 多供应商预设 | 多项目档案(`projects.json` + activeProjectId) |

## 数据模型

```typescript
interface SkillEntry {
  id: string;            // "owner/repo:path" 或 "local:<name>"
  name: string;
  description: string;
  source: { type: 'github' | 'skills-sh' | 'local'; uri: string };
  ref?: string;
  tags: string[];
  installedAt: string;
}

interface Project {
  id: string;
  name: string;
  path: string;          // 项目根目录(绝对路径)
  agents: string[];      // ["claude-code", "kimi-code", ...]
  skills: string[];      // SkillEntry.id 列表
  applyMode: 'symlink' | 'copy';
  createdAt: string;
  lastAppliedAt?: string;
}
```
