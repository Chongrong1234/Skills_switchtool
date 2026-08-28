<div align="center">

<img src="build/icon.png" width="110" alt="Skills SwitchTool" />

# 🛠 Skills SwitchTool

### 项目级的 Agent Skills 管理台:不同任务,不同技能组合,随时调配,一键切换

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/Chongrong1234/Skills_switchtool)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Runtime Deps](https://img.shields.io/badge/runtime%20deps-2-orange.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20Windows%20%C2%B7%20macOS-lightgrey.svg)](electron-builder.yml)

**Electron 桌面 App · 纯 CLI(含终端面板),共享同一份数据**

</div>

---

## 🤔 你是不是也遇到过……

- 同一个 AI 助手,写前端、写后端、写文档需要的技能完全不同,却只能共用**一坨全局 skills**?
- 给这个项目临时加的 skill 想撤掉,又怕动到**其它项目**的配置?
- 在 Claude Code 里精心配好一套技能,切到 Kimi Code / Cursor / Codex 又得**手动复制一遍**?

**Skills SwitchTool 把 skills 的管理单位从「全局」降到「项目」**:所有 skills 收进一个中央库,每个项目自由勾选自己的技能组合 —— 前端项目一套、后端项目一套、写作项目又是一套,随时增删、随时重配,互不干扰。切换项目时,对应组合一键「物化」到各家 AI 工具的项目级技能目录。

就像给枪换弹夹:不同任务,上不同弹药。咔哒一声,技能就位。🎯

交互模式仿照 [cc-switch](https://github.com/farion1231/cc-switch):**中央存储 + GUI 切换 + 写入目标工具配置位置 + 备份可回滚**。

## 🧩 不同任务,不同配方

```
🎨 my-blog(前端项目)      → ui-styling + banner-design + design-tokens
⚙️  api-server(后端服务)  → deploy-notes + api-design + sql-helper
📝 writing(内容写作)      → brand + slides + copywriting
```

一行命令换配方:

```bash
ssw project switch api-server    # 激活项目 → 该项目的技能组合自动写入各 agent 目录
```

GUI 里更简单:左侧栏点一下项目名,搞定。✅

## ✨ 亮点速览

| | |
|---|---|
| 🎯 **项目级管理,一项目一配方** | 每个项目绑定独立的「技能组合 + 目标 agents」,不同任务不同配方,随时增删调配 |
| 🗃️ **中央库,唯一事实来源** | 全部 skills 统一住在 `~/.skills-switch/library/`,组合只是引用,改一处处处生效 |
| 🔄 **一键切换,技能跟着项目走** | `switch` 一下整组换装:GUI 点项目名、CLI 敲一行,都行 |
| 🔗 **symlink 物化** | 默认软链写入 `.claude/skills` 等项目级目录,库更新即时生效;失败自动降级 copy 并告警 |
| 📸 **快照可回滚** | 每次 apply 自动快照(每项目留 5 份),配错了也能一键穿越回去 |
| 🔍 **智能推荐** | 识别项目技术栈,推荐 GitHub 高 star skills 充实配方;断网/限流安静降级,绝不甩脸子 |
| 🏪 **内置推荐库** | 精选 27 个高 star skills 仓库,覆盖软件开发/科研/设计/营销/DevOps 等 8 大类,离线可浏览,一键整仓安装 |
| 🖥️ **两种打开方式** | Electron 桌面 App 点点点、服务器纯 CLI/终端面板——同一份核心,同一份状态 |
| 🪶 **极致轻量** | 运行时仅 2 个依赖(express + commander);CLI 可打成零依赖单文件,拷到服务器即用 |

## 🚀 三分钟上手

```bash
npm install        # 安装依赖
npm run app        # 编译并启动桌面 App(需图形环境)
```

然后:**新建项目(绑定目录)→ 勾选 skills 和目标 agents → 一键 apply**。技能集已写入各 agent 的项目级 skills 目录,切换项目,技能跟着走。✅

> 💡 没有图形环境?`npm run dist:cli` 打出零依赖单文件 CLI,拷到服务器就能用(见下文 [CLI 章节](#-cli服务器版))。

## 📦 安装与启动

```bash
npm install        # 安装依赖(运行时依赖仅 express + commander)
npm run build      # tsc 编译到 dist/
npm test           # vitest 全量测试
```

数据根目录默认 `~/.skills-switch/`,可用 `SSW_HOME` 环境变量覆盖(测试隔离用)。

## 🖥️ 桌面 App(Electron)

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

图标由脚本生成(纯 Node 手写 PNG/ICO):`node scripts/make-icon.mjs` → `build/icon.png`(512×512)+ `build/icon.ico`(256×256 内嵌 PNG)。

## 🌍 多平台支持

| 平台 | 产物 | 构建方式 |
|---|---|---|
| Linux | `release/Skills SwitchTool-<版本>.AppImage` | 本机 `npm run dist` |
| Windows | `release/Skills SwitchTool Setup <版本>.exe`(NSIS,中文安装界面) | 本机 `npx electron-builder --win nsis`,或 CI |
| macOS | dmg + zip(**未签名**:首次打开需右键 →「打开」) | 仅 CI(macOS runner) |
| 任意(含服务器) | `release/cli/ssw.mjs`(零依赖单文件 CLI,Node ≥ 18) | `npm run dist:cli` |

**CI 自动构建**:`.github/workflows/release.yml` 在打 `v*` tag(或手动 dispatch)时并行构建三平台产物并上传到对应 Release。

**Windows 特别说明**:

- apply 默认 symlink;Windows 未开开发者模式/非管理员时创建 symlink 会被拒绝(EPERM),此时**自动降级为 copy 并在输出中告警**(降级后改动库需重新 apply 才生效)。也可建项目时直接选 `--mode copy`。
- 从 GitHub 安装/更新 skill 需要系统装有 **git** 且在 PATH;缺失时会收到「未找到 git 命令」的可读报错而不是崩溃。
- CLI 在 Windows 下用法相同:`node ssw.mjs agents`,或在 PowerShell/CMD 中 `ssw.cmd`(若全局安装)。PowerShell 中亦可直接 `node .\ssw.mjs ...`。

## ⌨️ CLI(服务器版)

`ssw`(别名 `skills`)是纯命令行 CLI,适合无 GUI 的服务器环境。**不带任何参数启动时(TTY 下)进入交互式终端面板**:

```bash
skills    # 或 ssw —— 打开终端面板:↑↓ 选项目,Enter 切换并 apply,
          # a apply / u unapply / r 回滚 / s 查看技能库 / q 退出
```

非 TTY(管道、脚本)下裸跑则打印帮助。子命令完整映射 core 能力:

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
ssw skill add --github <owner/repo 或 URL> [--subdir skills]   # 合集仓库用 --subdir 指定扫描根
ssw skill add --local /path/to/skill
ssw skill init --name X --desc "..."    # 自建 skill 脚手架
ssw skill remove <id>                    # 卸载并解除各项目绑定;github 根级条目卸载会连带同仓条目
ssw skill update [id]                   # 省略 id 更新全部 github 来源
ssw skill export                        # 导出迁移码(ssw1:owner/repo,...;仅 github 来源)
ssw skill import <code>                 # 粘贴迁移码批量安装;已有仓库跳过,部分失败时退出码非零
ssw catalog [--category dev] [--q 关键词]   # 内置推荐库:精选高 star 仓库,含已安装标记
ssw catalog install <owner/repo>        # 一键安装推荐库条目(自动带上合集子目录)
ssw recommend --path /abs/path [--keywords a,b,c]
```

约定:

- **id|name 寻址**:先精确匹配 id,再匹配 name;name 歧义时报错并列出候选;找不到退出码非零
- **全局 `--json`**:所有输出可切为 JSON(如 `ssw project list --json`),方便脚本化
- 错误信息打 stderr、退出码非零;成功输出打 stdout;缺必填参数时报错并打印该命令用法
- 数据目录与 GUI/桌面版共用 `~/.skills-switch/`(可用 `SSW_HOME` 覆盖),即三种前端共享同一份状态

本机使用:`npm run build` 后 `node dist/cli.js ...`(package.json 已注册 `bin: ssw` 与 `bin: skills`,`npm link` 后可直接 `ssw ...` 或 `skills`)。

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
```

## 🗂 目录结构

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
    catalog.ts    # 内置精选推荐库(27 个高 star 仓库 / 8 大类,离线可用);installed 标记;subdir 适配合集仓库
    migrate.ts    # 迁移码导出/导入(github 来源仓库简写集合)
  adapters/
    types.ts      # AgentAdapter 接口(PLAN.md 4.4)
    claude-code.ts kimi-code.ts cursor.ts codex.ts
    index.ts      # 适配器注册表
  server.ts       # Express 应用(API + 托管 public/)
  serve.ts        # startServer(port, host?):Electron 主进程进程内启动用
  cli.ts          # ssw/skills 命令行入口(commander,全子命令 + --json;无参数启动进 tui.ts 终端面板)
  tui.ts          # 终端交互面板(零依赖,stdin raw 模式 + ANSI 渲染;裸跑 ssw/skills 且是 TTY 时进入)
electron/
  main.mjs        # Electron 主进程:in-process 起服务(127.0.0.1+随机端口)+ BrowserWindow
public/           # 原生 HTML/CSS/JS 单页应用(无构建步骤)
scripts/
  make-icon.mjs   # 生成 build/icon.png(纯 Node 手写 PNG)
  build-cli.mjs   # esbuild 打包 CLI 单文件 release/cli/ssw.mjs(注入 createRequire)
tests/            # vitest,SSW_HOME 指向 mkdtemp 临时目录隔离,不碰真实 ~/.skills-switch
electron-builder.yml  # 打包配置:Linux AppImage → release/
```

## 🔌 API 列表(REST,JSON;错误统一 `{ "error": "..." }`)

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
| DELETE | `/api/skills/:id` | 卸载并解除各项目绑定(id 需 encodeURIComponent) |
| POST | `/api/skills/init` | 自建脚手架 `{name, description}` |
| GET | `/api/recommend?projectId=xx` | 技术栈 + 项目名关键词推荐,Top 10 |
| GET | `/api/catalog?category=&q=` | 内置精选推荐库(分类/关键词过滤,含 installed 标记) |
| GET | `/api/skills/export` | 导出迁移码 `{code, repos}`(仅 github 来源) |
| POST | `/api/skills/import` | 导入迁移码 `{code}`,返回 `{installed, skipped, failed}` |

## 🔄 与 cc-switch 的对应关系

| cc-switch | Skills SwitchTool |
|---|---|
| 中央存储各供应商配置 | 中央库 `~/.skills-switch/library/` 存放全部 skills(唯一事实来源) |
| GUI 中切换当前供应商 | GUI 中切换当前项目(switch) |
| 切换时写入 Claude Code 的 settings.json | apply 时写入各 agent 的项目级 skills 目录(`.claude/skills`、`.kimi-code/skills`、`.cursor/skills`、`.codex/skills`) |
| 写前备份、可回滚 | apply 前快照(`snapshots/<projectId>/`,保留最近 5 份),一键 rollback |
| 多供应商预设 | 多项目档案(`projects.json` + activeProjectId) |

## 🧬 数据模型

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

---

<div align="center">

**如果这个小工具帮你驯服了到处乱放的 skills,就点个 ⭐ Star 吧!**

发现问题?[提个 Issue](https://github.com/Chongrong1234/Skills_switchtool/issues) · 想加 agent 适配器?一个 spec 文件就能搞定,欢迎 PR 🎉

</div>
