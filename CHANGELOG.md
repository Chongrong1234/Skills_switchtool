# 更新日志

本项目遵循语义化版本;版本号单一来源是 `package.json`。
发布走 `npm run release`(干净工作区检查 → 全量测试 → 打 tag → 推送,tag 触发三平台 Release 构建)。

## v1.8.0(2026-09-02)

修复「推荐库联网搜索找不到/装不了 MCP server 仓库」(例如官方 matlab/matlab-mcp-server):
旧口径只搜 `topic:agent-skills`(纯 skills 生态标签,MCP 仓库不带),搜 "matlab mcp" 零结果;
即使拿到仓库地址也只能走 skill 整仓安装,因无 SKILL.md 报「未找到合法 skill」。

- **core `searchCatalogGithub` 支持 MCP 仓库搜索**(`src/core/catalog.ts`):新增 `kind: 'skill' | 'mcp'`,
  mcp 模式按 `topic:mcp-server` + `topic:model-context-protocol` 一词两查合并去重(裸 "mcp"/"server"
  关键词不参与检索,防泛化淹没);kind 缺省自动判定——搜索词含独立单词 mcp(如 "matlab mcp")即按
  MCP 搜;结果与条目都带 kind;installed 口径:skill 按注册表仓库前缀、mcp 按建议 server 名
  (`suggestMcpName` 清洗仓库名)比对 mcps.json
- **core `fetchGithubMcpConfig(repo)`**:MCP 的「下载」落地——MCP 是纯配置无实体,经 GitHub API 取
  默认分支 README,扫 ```json 围栏块提取 mcpServers(Claude 风格)/ servers(VS Code 风格)里的
  启动配置(command/args/env 或 url/serverUrl+headers,type=sse 识别),多 server 优先与仓库名相近者;
  仓库格式非法抛 McpError(→400),网络/无配置块降级 `{ spec: null, message }` 不抛
- **REST**:`GET /api/catalog/github` 新增 `kind=skill|mcp`(非法 400);新增
  `GET /api/catalog/github/mcp-config?repo=<>`(repo 必填,提取不到 200 + spec:null + message)
- **CLI**:`ssw mcp add --github <owner/repo>` 一键提取 README 配置写入注册表(--name 可省按仓库名推导,
  与 --command/--url 等互斥;提取不到报错并给手动添加指引);`catalog --q --github` 透传 `--kind`,
  输出按仓库类型分流安装/添加指引
- **桌面 GUI**:推荐库联网搜索跟随类型标签页(仅 MCP 时搜 MCP 仓库);结果卡片分类型带
  skills/MCP 标签,MCP 卡片为「添加」按钮——点击即读 README 配置、打开 MCP 弹窗预填
  (名称/描述/传输/命令参数一应预填,提取不到则有提示引导手动填),保存后卡片原地转「已添加」
- **TUI**:推荐库视图 / 与 i 搜索随 k 键类型过滤传 kind;结果行带 [MCP] 标记,底部指引按类型
  分流(MCP → `ssw mcp add --github`)

## v1.7.1(2026-09-02)

桌面 App 界面自适应(纯 CSS 响应式断点,不改 DOM 结构与交互):

- **宽屏(≥1500px)**:主区最大宽度 960 → 1200px,减少两侧留白浪费
- **中等窗口(≤1100px)**:侧栏 260 → 220px、主区内边距收窄;侧栏视图按钮改两行排布,防文字挤压
- **窄窗口(≤860px)**:左侧栏变为顶部横条——品牌、视图按钮、新建/设置按钮同行排列,项目卡横向滚动;主区占满全宽
- **超窄窗口(≤560px)**:弹窗/主标题收紧,推荐库搜索框、AI 配置行、操作按钮纵向堆叠
- Electron 窗口新增最小尺寸 720×540(自适应布局的可用下限)

## v1.7.0(2026-09-01)

技能库更新系统:定时检查 github 来源 skills 的上游更新,一键更新全部——

- **定时查询**(`src/serve.ts`):桌面 App/服务启动后 15s 首查,之后按间隔(默认 6h)定期检查;配置存 `update.json` 新增 `skillsAutoCheck`(默认开)/`skillsCheckIntervalHours`(默认 6,收敛 1-168),GUI 设置弹窗开关 + CLI `ssw update --skills-check on|off`;`setInterval(...).unref()` 不阻塞进程退出,全程静默不打扰
- **core `checkLibraryUpdates`**(`src/core/library.ts`):github 来源 skills 按 owner/repo 分组(整仓一次 clone,多 skill 共享),逐仓 `git fetch` 后 `rev-list --count HEAD..@{u}` 比上游落后几个提交;浅克隆无上游信息时兜底 `rev-parse` 比 sha;并发调用共享同一次在途检查;单仓失败只记该仓 error 不影响其它仓,整体失败降级 `{ ok:false, message }` 不抛异常;结果存内存态 `GET /api/skills/updates` 随时可读
- **一键更新**(`applyLibraryUpdates`):逐 skill 走既有 `updateSkill`(git pull + 重新注册,保留 useCount/stars 统计),可指定仓库子集;更新成功的仓库即时把内存态里 behind 清零
- **REST**:`GET /api/skills/updates`(读内存态)、`POST /api/skills/updates/check`(立即检查)、`POST /api/skills/updates/apply`(可选 repoIds 子集)
- **CLI**:`ssw skill update --check` 只检查不更新(列出落后仓库与提交数,有可更新时退出码 1 并引导 `ssw skill update`);`ssw skill update` 不带参数照旧更新全部
- **TUI**:技能库视图标题带可更新徽标(落后仓库数),`U` 键两步——先检查,有可更新再按 `U` 一键更新全部
- **桌面 GUI**:技能库页工具栏新增「检查更新」「一键更新全部」按钮 + 顶部提示条(落后仓库数);设置弹窗「软件更新」区新增技能库自动检查开关
- `runGit` 改为返回 stdout(供 rev-list/rev-parse 取输出),既有调用方不受影响

## v1.6.0(2026-09-01)

推荐库接入 GitHub 联网搜索:

- **core `searchCatalogGithub`**(`src/core/catalog.ts`):推荐库不再只是离线静态数据——按 `topic:agent-skills <关键词>` 联网搜 GitHub 仓库(复用 recommend 的 24h 缓存),多词合并去重、star 降序、上限 12;已入库的只标「已安装」不排除;断网/限流降级空结果 + message,绝不抛异常
- **AI 提炼关键词**(`src/core/ai.ts` 新增 `aiExtractGithubKeywords`):输入自然语言需求,已配置的模型先提炼英文搜索词再搜;未配置 key/模型失败降级用需求里的英文词兜底,再不行整句直搜——AI 是加分项不是必需品
- **结果带 GitHub 链接**:每条命中带仓库地址,GUI「仓库 ↗」外链直达,CLI/TUI 输出链接与 `ssw skill add --github` 安装指引
- **REST**:`GET /api/catalog/github?q=<>&ai=1`(q 空 400;降级返回 200 + message)
- **CLI**:`ssw catalog --q <词> --github` 直搜,`--ai` 先 AI 提炼关键词(蕴含 --github);`--json` 输出带 github 字段
- **TUI**:推荐库视图内 `/` 直搜、`i` AI 提炼关键词再搜,结果代替目录列表展示,`x` 清除(Esc 有结果先清结果)
- **桌面 GUI**:推荐库搜索框旁「GitHub 搜索」「AI 搜索」按钮,结果卡片带命中关键词/★/已安装标记/仓库外链/一键安装(自动探测合集子目录)

## v1.5.0(2026-09-01)

自动更新系统:对照 GitHub Releases 检查新版本,用户可手动下载安装包或配置自动更新——

- **检查更新**(`src/core/update.ts`):版本比较只看 tag 的 X.Y.Z 数字段(解析不了按更旧,坏 tag 不误报);6h 磁盘缓存(`cache/update-latest.json`),手动检查强制刷新;并发调用共享同一次在途请求;断网/限流/解析失败一律降级 `{ ok:false, message }`,绝不抛异常;API 地址可用 `SSW_UPDATE_API` 覆盖(测试注入)
- **按平台挑安装包**(`pickAsset`):win → `Setup*.exe`,mac → 按 arch 匹配 arm64/非 arm64 dmg,linux → AppImage
- **下载**:流式写 `.part` 再原子改名(不留半截文件),落盘 `<数据目录>/downloads/` 并置可执行位;进度并入 `GET /api/progress`(GUI 进度条零改动复用);同一文件已完整下载过幂等跳过;在途任务拒绝并发
- **桌面 GUI**:设置弹窗新增「软件更新」区(当前版本/检查更新/下载进度条/打开下载目录/自动检查+自动下载开关);侧栏顶部浮现更新横幅(发现新版本或下载完成时,点击开设置);桌面 App 启动时按配置自动检查(开了自动下载则后台拉包),全静默不影响启动
- **CLI `ssw update`**:不带选项=立即检查;`--download` 下载安装包(TTY 进度条走 stderr);`--open` 浏览器打开发布页;`--auto-check|--auto-download on|off` 读写配置(`update.json`,autoCheck 默认开、autoDownload 默认关)
- **REST**:`/api/update/status|check|config|download|open`;open 目标由服务端解析,只放行本项目 releases URL 与下载目录;资产 URL 强制 https;`openExternal` 只接受 https URL/绝对路径
- **TUI**:项目视图 `U` 键进更新视图(强制检查;下载与配置指向 CLI)
- doctor 数据文件健康检查纳入 `update.json`(四 → 五个)

顺带修复与增强:

- **github 安装合集子目录兜底**:未指定 `--subdir` 且根级扫描落空时,自动探测 `skills/`、`.agents/skills`、`.claude/skills` 常见合集子目录(`registerSkillsWithFallback`)——联网推荐命中的合集仓库多把 skills 收在子目录,只扫根级曾误报「仓库中未找到合法 skill」
- **git 进度解析语言无关化**:git 输出随界面语言本地化(zh_CN 是「接收对象中」),进度正则不再限定英文阶段名,中文系统下 GUI 进度条与错误摘要恢复正常;`parseProgressSegment`/`summarizeStderr` 导出供测试

## v1.4.9(2026-08-31)

新增 9 个主流 agent 框架适配器(10 → 19 家;目录约定全部来自各官方文档逐一核实,不靠猜):

- **OpenClaw**(自托管个人 AI 助手网关):检测 `~/.openclaw`,用户级 `~/.openclaw/skills`,项目级走开放规范互操作路径 `.agents/skills`
- **DeepSeek Harness**(`dsh`,DeepSeek 官方 agent harness):`.dsh/skills` 项目级 + 用户级
- **Qwen Code**(阿里):`.qwen/skills` 两级 + 项目级 MCP(`.qwen/settings.json` 的 `mcpServers`,远端 http 用 `httpUrl` 键)
- **Trae**(字节):`.trae/skills` 两级 + 项目级 MCP(`.trae/mcp.json`)
- **Factory Droid**:`.factory/skills` 两级 + 项目级 MCP(`.factory/mcp.json`,条目带 `type` 字段)
- **Cline** / **Continue** / **Crush** / **Amp**:skills 目录各就各位(Crush/Amp 用户级走 XDG `~/.config/...`;Amp 项目级用 `.agents/skills` 互操作路径)
- MCP 配置为 YAML/命令式/仅用户级的(dsh、OpenClaw、Cline、Continue、Crush、Amp)不声明 MCP 支持,apply MCP 时跳过并告警
- Goose / OpenHands / Grok CLI 的 skills 两级都走 `.agents/skills`,已被通用 `agents` 适配器覆盖,不重复设适配器

## v1.4.8(2026-08-31)

一键收养本机所有 agent 的既有 skills:

- **桌面 App 启动自动收养**:打开应用即扫描本机所有 agent 的用户级 skills 目录(`~/.claude/skills` 等),把已配置的 skills 自动收进中央库并展示在技能库,无需任何手动操作;幂等(已入库/同名跳过)、只读源目录、失败静默降级不影响启动
- **`ssw skill adopt --all`**:一次扫描所有 agent(`--user` 用户级 / `--path` 项目级),同名 skill 跨 agent 去重,多家共享的 `.agents/skills` 目录按 realpath 只扫一次,按 agent 分组输出明细
- REST `POST /api/skills/adopt` 支持 `{ all: true }`(缺省 user 级);GUI 收养弹窗新增「全部 agent」选项(选中自动切到用户级),按 agent 分组展示结果

## v1.4.7(2026-08-31)

AI 推荐升级(含 v1.4.6 的全部安全修复,该版本未单独发布):

- **AI 推荐可多次调用**:项目详情页新增「AI 推荐」区(此前只有新建项目弹窗能调一次),改需求描述可反复推荐
- **AI 联网搜 GitHub**:模型输出 `githubKeywords`(缺省用需求里的英文词兜底),按 `topic:agent-skills <关键词>` 搜索相关仓库(复用 24h 缓存),去重、排除已入库、按 star 排序;GUI 一键「加入库并绑定」,CLI/TUI 展示安装指引
- **本地与联网两路成败隔离**:模型挂了仍有 GitHub 结果,GitHub 挂了不影响本地结果;技能库为空时跳过模型、只走联网推荐
- CLI `ai recommend` / `project create --ai`、TUI `i` 键视图同步展示 GitHub 联网推荐

## v1.4.6(2026-08-31)

安全加固与发布流程修复:

- **安全**:profile 导入全量校验条目 id/name——恶意 bundle 的 `local:../../..` 此前可穿越出库目录删写文件;落盘目标追加"必须在库目录内"断言作双保险
- **安全**:REST 服务增加本机回环防护——Host 必须指向回环(防 DNS rebinding),带跨站 Origin 的请求一律 403(此前恶意网页可用 simple request 跨域触发 apply/rollback 等写端点)
- **安全**:数据文件(`ai.json` 的 apiKey、`mcps.json` 的 env token 等)落盘权限收窄为 0600,对齐各家 CLI 凭据文件惯例
- **修复**:GUI 导入配置库被 `express.json` 默认 100KB 上限 413 拒绝,放宽到 50MB
- **修复**:profile 导入的项目全部幂等跳过时,`activeProjectId` 静默丢失不落盘
- **修复**:REST 写请求进程内串行化,GUI 连点/并发写不再互相覆盖丢条目
- **修复**:copy 物化增加归属标记 `.ssw-copy`,unapply 不再可能误删用户手工放置的同名同内容目录(旧副本无标记时要求文件集合不越界)
- **工程**:新增 `npm run release` 一键发布脚本(v1.3.0、v1.4.0~1.4.4 曾漏打 tag 漏发 Release);新增本更新日志
- **工程**:删除根目录旧版前端残留 `app.js`/`index.html`;移除无人实现的 `AgentAdapter.validate?`;推荐与排序的项目名分词口径统一(≥2);修复 electron-builder `desktopName` 警告(Linux 窗口关联启动器);npm 增加 `prepack` 钩子

## v1.4.5(2026-08-31)

- 修复:AI 请求不再显式传 `temperature`(kimi-k2 系端点只允许 temperature=1,显式传 0.2 会被 400 拒绝导致推荐降级)

## v1.4.4(2026-08-31)

- TUI 终端面板支持 `n` 新建项目(依次询问名称/路径/agents/模式/开发需求,填了需求走 AI 推荐)、`x` 删除项目档案(`y` 二次确认,只删档案不动磁盘)

## v1.4.3(2026-08-31)

- 修复:AI 推荐绑定技能后,项目详情页立即刷新

## v1.4.2(2026-08-31)

- 推荐库 skills 与 MCP 分流浏览/安装(`kind` 过滤),分类带条目统计

## v1.4.1(2026-08-31)

- 修复:新建项目后列表立即刷新

## v1.4.0(2026-08-31)

- 技能热度排序:使用次数(绑定即计、只增不减)+ 项目分类匹配 + 仓库 stars 加权,常用技能在选配时排前面;AI 推荐同等相关时优先高 stars/常用

## v1.3.0(2026-08-31)

- AI 技能推荐:设置里配置模型名 / apiKey / 中转站地址(预设 Kimi/DeepSeek/OpenAI/OpenRouter),新建项目按开发需求从本地技能库智能选配;未配置或断网安静降级
- MCP 服务页支持弹窗编辑 server 配置(同名 upsert)

## v1.2.0(2026-08-30)

- 内置推荐库:111 个高 star skill 仓库 + 26 个常用 MCP server / 13 大类,离线可用
- `skill init` 支持粘贴现成 SKILL.md(`--content`/`--file`)
- doctor 环境自检;skill 名称简写寻址;`project create` 免 `--agents`(取本机检测)
- Windows CI 修复(`npm.cmd` 需 `shell: true`;8.3 短名路径比较)

更早版本见 git 历史。
