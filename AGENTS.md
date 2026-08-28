# AGENTS.md

> 面向 AI 编码助手的项目指南。描述的是**当前代码的实际状态**;`PLAN.md` 是早期计划书(其中 Ink TUI、zod、Tauri 等均未落地,以本文件与 `README.md` 为准)。

## 项目概述

**Skills SwitchTool**(`skills-switchtool`,v0.1.0):项目中心化的 Agent Skills 管理工具。交互模式仿照 cc-switch:**中央存储 + 切换 + 写入目标工具配置位置 + 快照可回滚**。

核心概念:

- **中央库是唯一事实来源**:全部 skills 实体存放在 `~/.skills-switch/library/`(可用 `SSW_HOME` 环境变量覆盖,测试隔离用)。
- **项目是一等公民**:项目档案(`projects.json`)记录 `项目 ↔ 技能集 ↔ 目标 agents` 绑定与 `activeProjectId`。
- **apply = 物化**:把项目技能集写入各 agent 的项目级 skills 目录(`.claude/skills`、`.kimi-code/skills`、`.cursor/skills`、`.codex/skills`)。默认 symlink(库改动即时生效),可选 copy;symlink 失败自动降级 copy 并告警。同名冲突的既有内容先移入快照再覆盖。
- **快照回滚**:每次 apply 前在 `snapshots/<projectId>/` 建快照,每项目保留最近 5 份,`rollback` 逆序还原最近一次。

三个前端共享同一个 TypeScript 核心引擎(`src/core/`),也共享同一份磁盘状态(`SSW_HOME`):

1. **Web GUI**:Express 托管 `public/` 单页应用(原生 HTML/CSS/JS,**无构建步骤**)。
2. **Electron 桌面 App**:主进程内**进程内启动** Express(`127.0.0.1` + 随机空闲端口),不依赖外部 node 进程;单实例锁,窗口全关即退出。
3. **CLI(`ssw`,别名 `skills`)**:commander 实现,子命令纯命令行非交互,适合服务器;子命令完整映射 core 能力,全局 `--json` 输出。**不带参数启动(TTY 下)进入交互式终端面板**(`src/tui.ts`,零依赖:stdin raw 模式 + ANSI 渲染);非 TTY 裸跑打印帮助。

## 技术栈

- **语言/运行时**:TypeScript 5.7(strict)、Node.js(ESM,`"type": "module"`,`module: NodeNext`;CLI 单文件分发目标 Node ≥ 18)。
- **运行时依赖仅两个**:`express`(REST API + 静态托管)、`commander`(CLI)。不要轻率新增运行时依赖。
- **开发依赖**:typescript、tsx(开发模式)、vitest(测试)、electron + electron-builder(桌面打包)、esbuild(CLI 单文件打包)。
- 注意:**没有** zod、Octokit、Ink、React(PLAN.md 提到但未采用);SKILL.md frontmatter 用自写的单行 `key: value` 解析器(`src/core/library.ts` 的 `parseFrontmatter`),GitHub API 直接用全局 `fetch`。

## 构建与常用命令

```bash
npm install        # 安装依赖
npm run dev        # 开发模式:tsx 直接跑 src/index.ts,默认 http://localhost:5174(PORT 覆盖)
npm run build      # tsc 编译 src/ → dist/(声明与 sourcemap 均关闭)
npm start          # 运行编译产物 dist/index.js
npm test           # vitest run 全量测试
npm run app        # 编译 + electron . 起桌面窗口(需图形环境)
npm run dist       # 编译 + electron-builder,产出 Linux AppImage 到 release/
npm run dist:cli   # 编译 + esbuild 打包单文件 CLI → release/cli/ssw.mjs(零依赖)
```

CLI 本机使用:`npm run build` 后 `node dist/cli.js ...`(`package.json` 已注册 `bin: ssw`)。图标用 `node scripts/make-icon.mjs` 重新生成(纯 Node 手写 PNG → `build/icon.png`)。

## 目录结构与模块划分

```
src/
  core/                  # 核心引擎,不依赖任何前端;GUI/CLI/Electron 零改动复用
    paths.ts             # SSW_HOME 路径常量;每次调用重读环境变量(测试隔离的关键)
    types.ts             # SkillEntry / Project / ProjectsData / ApplyMode
    registry.ts          # registry.json 读写;atomicWriteJson(tmp+rename 原子写)、readJsonSafe(损坏容错)
    library.ts           # 中央库:github→git clone --depth 1、local→复制、卸载、更新、initSkill 脚手架;
                         #   validateSkillDir 校验 SKILL.md frontmatter(name/description 必填);LibraryError
    projects.ts          # 项目档案 CRUD + activeProjectId;id 用 crypto.randomUUID()
    apply.ts             # applyProject / unapplyProject:物化到各 agent 目录;幂等(已是指向库的 symlink 则跳过)
    snapshot.ts          # 快照/回滚;MAX_SNAPSHOTS = 5
    recommend.ts         # 技术栈检测(package.json/go.mod/Cargo.toml/pyproject.toml)+ GitHub Search API;
                         #   24h 缓存(cache/);断网/限流降级返回 { items: [], message },绝不抛异常
    migrate.ts           # 迁移码:ssw1:owner/repo,... 仅含 github 来源,按仓库去重;
                         #   importSkillsCode 幂等跳过已有、单仓失败不中断;installFn 可注入(测试)
  adapters/
    types.ts             # AgentAdapter 接口(id/displayName/detect/projectSkillsDir/capabilities/validate?)
    factory.ts           # makeAdapter(spec):detect 依据 ~/<homeDir> 是否存在,skills 目录 = <项目根>/<skillsSubDir>
    claude-code.ts kimi-code.ts cursor.ts codex.ts   # 各一个 9 行 spec
    index.ts             # adapters 注册表 + getAdapter(id)
  server.ts              # Express 应用:createApp(),REST API + 托管 public/;统一错误格式 { "error": "..." }
  serve.ts               # startServer(port, host?) 可复用启动函数(web / Electron / CLI serve 三处共用)
  cli.ts                 # ssw/skills 入口:全部子命令;id|name 寻址(id 精确优先,name 歧义列候选报错);
                         #   --json;无参数且 TTY 时动态 import tui.js 进终端面板,非 TTY 打印帮助
  tui.ts                 # 终端交互面板:项目列表 + ↑↓/Enter/a/u/r/s/q 按键;stdin raw 模式 + ANSI 整帧重绘
  index.ts               # web 模式入口:listen(默认 5174,PORT 覆盖)
electron/main.mjs        # Electron 主进程:动态 import dist/serve.js,127.0.0.1+端口 0,BrowserWindow 加载
public/                  # 原生单页应用(index.html / app.js / style.css),无构建步骤;深/浅双主题:
                         #   CSS 变量在 style.css 顶部,选择存 localStorage(ssw-theme),
                         #   index.html head 内联脚本在首屏前恢复主题
scripts/                 # make-icon.mjs(生成图标)、build-cli.mjs(esbuild 打 CLI 单文件,注入 createRequire)
tests/                   # vitest,每文件对应一个 core 模块 + cli.test.ts 端到端
electron-builder.yml     # 打包配置:Linux AppImage + Windows NSIS + macOS dmg/zip → release/,只带 dist/ electron/ public/ package.json;图标 build/icon.png + build/icon.ico
```

新增 agent 适配器:在 `src/adapters/` 加一个 spec 文件并在 `index.ts` 的 `adapters` 数组注册即可,引擎不用动。

## 代码风格约定

- **注释与文档一律用简体中文**:每个源文件开头有文件级 docstring 说明职责与关键决策;行内注释解释"为什么"(如 projects.ts 里关于不能复用模块级空对象常量的注释)。改动行为时同步更新对应注释。
- **ESM + NodeNext**:源码内相对 import 必须带 `.js` 扩展名(如 `from './core/paths.js'`)。
- **strict TypeScript**:不开 `any` 口子;core 模块之间只允许 core → core、core → adapters,绝不允许 core 依赖 server/cli/electron。
- **持久化一律走 `atomicWriteJson`(tmp + rename)**,读取走 `readJsonSafe`(文件不存在/损坏返回 fallback,不抛异常)。
- **路径不硬编码 `~/.skills-switch`**:一律用 `src/core/paths.ts` 的函数,保证 `SSW_HOME` 覆盖生效。
- **降级而非崩溃**是既定策略:推荐引擎断网降级空结果;symlink 失败降级 copy 并告警;JSON 损坏容错为空。
- CLI 约定:错误信息打 **stderr** 且退出码非零,成功输出打 stdout;缺必填参数时报错并打印该命令用法。
- API 约定:REST + JSON,错误统一 `{ "error": "..." }`;`LibraryError` 映射 400,其余 500。

## 测试

- 框架:**vitest**(`vitest run`),配置在 `vitest.config.ts`:`environment: 'node'`、`pool: 'forks'`、`testTimeout: 20000`。
- 测试文件在 `tests/*.test.ts`,每个 core 模块一个对应文件;`cli.test.ts` 是端到端测试,用 `child_process` 跑**编译产物** `dist/cli.js`(`beforeAll` 里先自动跑 `npm run build`)。
- **隔离约定(必须遵守)**:测试在 `beforeEach` 里把 `process.env.SSW_HOME` 指向 `fs.mkdtemp` 临时目录,`afterEach` 里删除该环境变量并 `rm` 临时目录——绝不触碰真实 `~/.skills-switch`。涉及真实文件系统的测试保持串行(这也是 `pool: 'forks'` 的原因)。
- 网络相关测试注入假 `fetch`(`recommendForProject(path, name, fetchImpl)` 的第三参),不打真实 GitHub API。
- 提交改动前跑 `npm test`,当前基线:11 个文件 86 个用例全绿。

## 安全注意事项

- 本工具的核心动作是**写用户机器上其它工具的配置目录**(`.claude/skills` 等):任何 apply 必须先快照、可回滚;同名冲突不许直接覆盖,先移入快照。
- `unapply` 只删除"确定是我们创建的"内容:symlink 需指向库内;copy 目录需与库内 `SKILL.md` 内容一致。
- `skill add --github` 会执行 `git clone` 到库目录;`skill update` 会 `git pull --ff-only`。URI 经 `normalizeGithubUri` 白名单式解析,只接受 `owner/repo` 或完整 GitHub URL。
- 桌面版 BrowserWindow 开 `contextIsolation: true`、`nodeIntegration: false`,服务仅监听 `127.0.0.1`。
- Express 服务**无认证**:Web 模式默认绑本机,部署到服务器时留意 `ssw serve` 的监听范围。
- 不要把 `SSW_HOME` 指向的目录当作可信输入边界——它存放的就是本工具的全部状态,损坏时要容错而不是崩溃。
