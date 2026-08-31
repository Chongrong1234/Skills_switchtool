<div align="center">

<img src="build/icon.png" width="110" alt="Skills SwitchTool" />

# 🛠 Skills SwitchTool

### 按项目管理 Agent Skills:一个项目一套技能组合,模型不再调错技能

[![Version](https://img.shields.io/badge/version-1.4.9-blue.svg)](https://github.com/Chongrong1234/Skills_switchtool/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Runtime Deps](https://img.shields.io/badge/runtime%20deps-2-orange.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20Windows%20%C2%B7%20macOS-lightgrey.svg)](electron-builder.yml)

**Electron 桌面 App · 纯 CLI(含终端面板),共享同一份数据**

</div>

---

## 简介

### 问题:全局 skills 一多,模型就开始"串台"

Agent skills 默认是**全局共享**的:所有项目用过的 skills 都堆在同一个目录里,模型每接一个任务都会把全部 skills 扫一遍。skills 越积越多,问题就来了:

- 写后端接口时,模型却调用了上个前端项目留下的 `banner-design`,**任务跑偏**;
- 同类 skill 装了好几份(比如三套不同的代码规范),模型随机挑一个用,**输出忽左忽右**;
- 临时加的 skill 忘了撤,长期污染上下文——token 多花了,活还干错了。

根因只有一个:**skills 的管理单位是「全局」,而任务的边界是「项目」。**

### 解法:把 skills 的管理单位从「全局」降到「项目」

Skills SwitchTool 让每个项目绑定**自己专属的技能组合**,只把这套组合物化到该项目的 agent 技能目录(支持 19 家:`.claude/skills`、`.kimi-code/skills`、`.cursor/skills`、`.codex/skills`、`.gemini/skills`、`.qwen/skills`、`.trae/skills`、`.dsh/skills`、`.factory/skills`、`.cline/skills`、`.continue/skills`、`.crush/skills` 等,含通用互操作目录 `.agents/skills`)。模型在这个项目里工作时,**只看得到、只调得到属于这个项目的 skills**——前端项目里不会出现写作技能,后端项目里不会冒出设计技能,任务不再错乱。

```
🎨 my-blog(前端项目)      → ui-styling + banner-design + design-tokens
⚙️  api-server(后端服务)  → deploy-notes + api-design + sql-helper
📝 writing(内容写作)      → brand + slides + copywriting
```

切换项目一行命令,技能跟着项目走:

```bash
ssw project switch api-server    # 激活项目 → 该项目的技能组合自动写入各 agent 目录
```

工作方式仿照 [cc-switch](https://github.com/farion1231/cc-switch):**中央库统一存储 + 项目级技能组合 + 物化到目标工具配置位置 + 快照可回滚**。

### 亮点速览

| | |
|---|---|
| 🎯 **一项目一配方** | 每个项目绑定独立的「技能组合 + 目标 agents」,不同任务不同配方,互不干扰,随时增删重配 |
| 🗃️ **中央库,唯一事实来源** | 全部 skills 统一收在 `~/.skills-switch/library/`,项目组合只是引用,改一处处处生效 |
| 🔄 **一键切换** | `switch` 一下整组换装:GUI 点项目名、CLI 敲一行,技能组合即刻写入各 agent 项目目录 |
| 🔗 **symlink 物化** | 默认软链写入,库更新即时生效;失败自动降级 copy 并告警;同名冲突先移入快照再覆盖 |
| 🔌 **MCP 服务也按项目管** | MCP server 集中在库里登记(stdio/http/sse),按项目绑定;apply 时**合并**写入各 agent 的项目级配置(`.mcp.json`、`.kimi-code/mcp.json`、`.cursor/mcp.json`、`.codex/config.toml`),保留你已有的其它配置,同样走快照可回滚 |
| 📸 **快照可回滚** | 每次 apply 自动快照(每项目留 5 份),配错了一键还原 |
| 🌐 **全局共享** | 项目配方之外,还可把选定 skills 物化到各 agent 的**用户级**目录(`~/.claude/skills` 等):一次配置,该 agent 的所有项目共享 |
| 📦 **配置库整体搬家** | `ssw profile export/import` 把技能库 + MCP + 项目档案 + 全局共享打成单文件,跨机器、跨平台共享同一份配置;导入幂等 |
| 🤝 **收养既有 skills** | `ssw skill adopt` 把各 agent 目录里已存在的 skills 一键收进中央库,先纳管再统一分发;`--all` 一次扫描所有 agent(同名去重);桌面 App **启动时自动收养**本机各 agent 的用户级 skills,打开即见 |
| 🔍 **智能推荐 + 内置推荐库** | 识别项目技术栈推荐 GitHub 高 star skills;另内置 111 个精选 skill 仓库 + 26 个常用 MCP server / 13 大类(分类带条目统计),skills 与 MCP 分流浏览、分开安装,离线可用;断网安静降级 |
| 🤖 **AI 技能推荐** | 填一句开发需求,AI 读本地技能库给出推荐供勾选绑定,并**联网搜 GitHub** 相关仓库(模型给搜索关键词,需求英文词兜底;可一键安装并绑定);新建项目与**项目详情页可多次调用**;模型/baseUrl/API Key 在设置里配,官方端点或 OpenAI 兼容中转站均可(预设 Kimi/DeepSeek/OpenAI/OpenRouter);未配置或断网安静降级 |
| 🔥 **热度排序选配** | 给项目/全局共享选技能时,常用的排前面:记录每个 skill 的使用次数(绑定即计、只增不减)、GitHub 仓库 stars(安装/更新时采集),再结合项目技术栈与名称关键词匹配加权排序;AI 推荐也把 stars/用量作为相关度相近时的优先依据 |
| 🖥️ **两种打开方式** | Electron 桌面 App 点点点、纯 CLI/终端面板——同一份核心,同一份状态 |
| 🪶 **极致轻量** | 运行时仅 2 个依赖(express + commander);CLI 可打成零依赖单文件,拷到服务器即用 |

## 下载(从头开始,复制粘贴即用)

所有发布版本都在 [GitHub Releases](https://github.com/Chongrong1234/Skills_switchtool/releases) 页面。以下命令均可直接复制粘贴;示例用最新版 **v1.4.9**,下载历史版本把版本号换掉即可(现有:`v1.4.9`、`v1.4.5`、`v1.2.0`)。

### Linux 桌面版(AppImage)

```bash
# 下载
curl -L -o Skills.SwitchTool.AppImage \
  https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.4.9/Skills.SwitchTool-1.4.9.AppImage

# 赋可执行权限并运行(也可在文件管理器里双击)
chmod +x Skills.SwitchTool.AppImage
./Skills.SwitchTool.AppImage
```

不想记版本号,一条命令永远拿最新版:

```bash
url=$(curl -s https://api.github.com/repos/Chongrong1234/Skills_switchtool/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*AppImage"' | cut -d'"' -f4) \
  && curl -L -o Skills.SwitchTool.AppImage "$url" \
  && chmod +x Skills.SwitchTool.AppImage && ./Skills.SwitchTool.AppImage
```

> 容器/受限环境中启动需追加 `--no-sandbox`。

### Windows 桌面版(NSIS 安装包,中文安装向导)

浏览器直接下载:[Skills.SwitchTool.Setup.1.4.9.exe](https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.4.9/Skills.SwitchTool.Setup.1.4.9.exe),双击按向导安装(可选安装目录)。

或在 PowerShell 中复制粘贴:

```powershell
curl.exe -L -o Skills.SwitchTool.Setup.exe `
  "https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.4.9/Skills.SwitchTool.Setup.1.4.9.exe"
.\Skills.SwitchTool.Setup.exe        # 向导式安装;静默安装用 .\Skills.SwitchTool.Setup.exe /S
```

### macOS 桌面版(dmg,Apple Silicon)

```bash
curl -L -o Skills.SwitchTool.dmg \
  https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.4.9/Skills.SwitchTool-1.4.9-arm64.dmg
open Skills.SwitchTool.dmg    # 拖进「应用程序」;未签名,首次打开需右键 →「打开」
```

### 服务器 / 纯 CLI(零依赖单文件)

CLI 单文件不随 Release 发布,从源码构建一次即可(只需 Node ≥ 18):

```bash
git clone https://github.com/Chongrong1234/Skills_switchtool.git
cd Skills_switchtool
npm install
npm run dist:cli            # 产出 release/cli/ssw.mjs:零依赖,拷到任意服务器即用

./release/cli/ssw.mjs doctor     # 先自检环境
./release/cli/ssw.mjs            # TTY 下裸跑进入交互式终端面板
```

要从源码构建桌面 App 或跑测试,见下文「使用方法」。

## 使用方法

### 安装与构建

```bash
npm install        # 安装依赖(运行时依赖仅 express + commander)
npm run build      # tsc 编译到 dist/
npm test           # vitest 全量测试
```

数据根目录默认 `~/.skills-switch/`,可用 `SSW_HOME` 环境变量覆盖。

### 三分钟上手

```bash
npm run app        # 编译并启动桌面 App(需图形环境)
```

然后:**新建项目(绑定目录)→ 勾选 skills 和目标 agents → 一键 apply**。技能集即写入各 agent 的项目级 skills 目录;之后切换项目,技能跟着走。

> 💡 没有图形环境?用 `npm run dist:cli` 打出零依赖单文件 CLI 拷到服务器(见下文「单文件分发」)。

### 桌面 App(Electron)

```bash
npm run app    # 开发运行:先 tsc 编译,再 electron . 起桌面窗口(需图形环境)
npm run dist   # 打包:编译 + electron-builder,产出 Linux AppImage 到 release/
```

AppImage 用法:

```bash
chmod +x "release/Skills SwitchTool-"*.AppImage
./release/Skills\ SwitchTool-*.AppImage        # 命令行运行;也可文件管理器中双击
```

在容器/受限环境(或部分无内核沙箱支持的系统)中,Electron 可能需要追加 `--no-sandbox` 才能启动。

### CLI(服务器版)

`ssw`(别名 `skills`)是纯命令行 CLI。**不带任何参数启动时(TTY 下)进入交互式终端面板**:

```bash
skills    # 或 ssw —— ↑↓ 选项目,Enter 切换并 apply,n 新建项目(名称/路径/agents/模式/可选 AI 需求),
          # x 删除项目(y 确认) / a apply / u unapply / r 回滚 / i AI 推荐(输入需求,结果视图内 a 并入项目) / s 技能库 / m MCP 库
          # g 全局共享(视图内 a/u/r 作用于全局) / c 推荐库(视图内 c 切换分类、k 切换 skills/MCP 类型) / d 环境自检 / q 退出
```

非 TTY(管道、脚本)下裸跑则打印帮助。常用子命令:

```bash
ssw doctor                              # 环境自检:数据目录/git/agent 检测/数据文件健康度,附修复建议
ssw agents                              # 各 agent 适配器及 detected 状态
ssw project list                        # 项目列表,* 为当前激活项
ssw project create --name X [--agents claude-code,kimi-code] [--path /abs/path] [--mode symlink|copy]
                                        # --agents 缺省取本机检测到的 agent;--path 缺省取当前目录
                                        # [--ai "开发需求"]:AI 读技能库推荐并自动绑定(需先 ssw ai config 配 key)
ssw ai config [--preset kimi|deepseek|openai|openrouter] [--base-url X] [--model Y] [--api-key Z]
                                        # 查看/设置 AI 配置(不带选项 = 查看;baseUrl 可填中转站)
ssw ai test                             # 测试 AI 连接(最小 chat 请求)
ssw ai recommend "<开发需求>" [--bind <id|name>]   # AI 从技能库推荐;--bind 并入项目技能集
ssw project switch <id|name>            # 设为当前项目并 apply
ssw project apply / unapply / rollback [id|name]
ssw project bind <id|name> <skillId|name...> # 设置项目技能集(整体替换;skill 可用名称简写)
ssw project bind-mcp <id|name> <mcpName...>   # 设置项目 MCP 服务集(整体替换)
ssw mcp list
ssw mcp add --name X --command npx [--args -y,pkg] [--env K=V,...]   # stdio 本地服务
ssw mcp add --name X --url https://... [--transport sse] [--header K=V,...]  # 远端服务
ssw mcp remove <name>                        # 删 server 并解除各项目绑定
ssw skill list                          # 带 ★stars 与使用次数热度标记
ssw skill add --github <owner/repo 或 URL> [--subdir skills]   # 合集仓库用 --subdir 指定扫描根
ssw skill add --local /path/to/skill
ssw skill init --name X --desc "..."    # 自建 skill 脚手架
ssw skill init --file SKILL.md          # 粘贴/导入现成 SKILL.md(--content 直接给文本;frontmatter 自动带出 name/desc)
ssw skill remove <id|name> / update [id|name]
ssw skill export / import <code>        # 迁移码:批量搬家 skills
ssw skill adopt --agent claude-code [--user|--path .]   # 把 agent 目录里既有的 skills 收进中央库
ssw skill adopt --all [--user|--path .]   # 一次扫描所有 agent(同名跨 agent 去重,同目录只扫一次);桌面 App 启动时会自动做用户级收养
ssw catalog [--category dev] [--kind skill|mcp] [--q 关键词]   # 内置推荐库浏览;--kind 把 skills 与 MCP 分流
ssw catalog categories                  # 分类清单:每类条目数(skill/MCP 细分)
ssw catalog install <owner/repo|mcp名>   # 一键安装推荐库条目
ssw recommend [--path /abs/path] [--keywords a,b,c]            # 按技术栈智能推荐
ssw global show / bind <skillId|name...> / agents <agentId...> [--mode symlink|copy]  # 全局(用户级)共享
ssw global apply / unapply / rollback   # 物化到各 agent 用户级目录(~/.claude/skills 等),可回滚
ssw profile export [--file x.json]      # 整套配置库导出为单文件(跨机器/跨平台搬家)
ssw profile import <file>               # 导入配置库(幂等,已有条目跳过)
```

约定:项目与 skill 均支持 `id|name` 寻址(先精确匹配 id,再匹配 name,歧义时报错列候选);全局 `--json` 输出方便脚本化;错误打 stderr、退出码非零;clone/pull 时终端下显示进度条(写 stderr,不干扰 `--json` 解析)。CLI 与桌面版共用 `~/.skills-switch/`,两个前端看到的是同一份状态。

本机使用:`npm run build` 后 `node dist/cli.js ...`(`npm link` 后可直接 `ssw ...` 或 `skills ...`)。

### 单文件分发(拷到服务器即用)

```bash
npm run dist:cli     # 产出 release/cli/ssw.mjs(esbuild 打包,零依赖,Node ≥ 18)
```

把 `ssw.mjs` 拷到任意服务器即可使用(`./ssw.mjs agents` 或 `node ssw.mjs agents`)。需要配置的只有一项:数据目录默认 `~/.skills-switch/`,可用 `SSW_HOME` 覆盖,如 `export SSW_HOME=/data/skills-switch`。

### 多平台与注意事项

| 平台 | 产物 | 构建方式 |
|---|---|---|
| Linux | `release/Skills SwitchTool-<版本>.AppImage` | `npm run dist` |
| Windows | `release/Skills SwitchTool Setup <版本>.exe`(NSIS,中文安装界面) | `npx electron-builder --win nsis`,或 CI |
| macOS | dmg + zip(**未签名**:首次打开需右键 →「打开」) | CI(macOS runner) |
| 任意(含服务器) | `release/cli/ssw.mjs`(零依赖单文件 CLI) | `npm run dist:cli` |

**Windows 特别说明**:

- apply 默认 symlink;未开开发者模式/非管理员时创建 symlink 会被拒绝(EPERM),此时**自动降级为 copy 并在输出中告警**(降级后改动库需重新 apply 才生效)。也可建项目时直接选 `--mode copy`。
- 从 GitHub 安装/更新 skill 需要系统装有 **git** 且在 PATH;缺失时会收到可读报错而不是崩溃。

---

<div align="center">

**如果这个小工具帮你驯服了到处乱放的 skills,就点个 ⭐ Star 吧!**

发现问题?[提个 Issue](https://github.com/Chongrong1234/Skills_switchtool/issues) · 想加 agent 适配器?一个 spec 文件就能搞定,欢迎 PR 🎉

</div>
