# AGENTS.md

> 面向 AI 编码助手的项目指南。描述的是**当前代码的实际状态**;`PLAN.md` 是早期计划书(其中 Ink TUI、zod、Tauri 等均未落地,以本文件与 `README.md` 为准)。

## 项目概述

**Skills SwitchTool**(`skills-switchtool`,v1.8.0):项目中心化的 Agent Skills 管理工具。交互模式仿照 cc-switch:**中央存储 + 切换 + 写入目标工具配置位置 + 快照可回滚**。

核心概念:

- **中央库是唯一事实来源**:全部 skills 实体存放在 `~/.skills-switch/library/`(可用 `SSW_HOME` 环境变量覆盖,测试隔离用);MCP server 是纯配置,集中在 `mcps.json` 注册表(name 即唯一键)。
- **项目是一等公民**:项目档案(`projects.json`)记录 `项目 ↔ 技能集 ↔ MCP 服务集 ↔ 目标 agents` 绑定与 `activeProjectId`。
- **apply = 物化**:把项目技能集写入各 agent 的项目级 skills 目录(claude-code→`.claude/skills`、kimi-code→`.kimi-code/skills`、cursor→`.cursor/skills`、codex→`.codex/skills`、gemini-cli→`.gemini/skills`、windsurf→`.windsurf/skills`、roo-code→`.roo/skills`、qwen-code→`.qwen/skills`、trae→`.trae/skills`、factory-droid→`.factory/skills`、deepseek-harness→`.dsh/skills`、cline→`.cline/skills`、continue→`.continue/skills`、crush→`.crush/skills`;agents/copilot/opencode/openclaw/amp 五家项目级都指向通用 `.agents/skills`——Agent Skills 开放规范的互操作路径,同时启用时幂等跳过)。默认 symlink(库改动即时生效),可选 copy;symlink 失败自动降级 copy 并告警。同名冲突的既有内容先移入快照再覆盖。MCP 服务集**合并**写入各 agent 的项目级配置(claude-code→`.mcp.json`,kimi-code→`.kimi-code/mcp.json`,cursor→`.cursor/mcp.json`,codex→`.codex/config.toml` 的 `[mcp_servers.*]` 段,qwen-code→`.qwen/settings.json` 的 mcpServers 字段,trae→`.trae/mcp.json`,factory-droid→`.factory/mcp.json`):保留用户已有条目、同名覆盖,已存在的配置文件先整体进快照再写。
- **全局(用户级)共享应用**(`src/core/global.ts`):把选定 skills 物化到各 agent 的用户级 skills 目录(`~/.claude/skills` 等,即适配器的 `userSkillsDir()`),一次配置、该 agent 的所有项目共享。档案存 `global.json`,快照挂在固定名 `__global__` 下,复用 apply.ts 的物化/移除原语与 snapshot.rollback。**MCP 是项目级概念,全局共享只管 skills**。CLI(`ssw global`)、REST(`/api/global*`)、桌面 GUI(「全局共享」视图)、TUI(g 键)均已接入。
- **配置库导出/导入**(`src/core/profile.ts`):`ssw-profile@1` 单文件 bundle(skills 注册表 + MCP + 项目档案 + 全局档案 + local 技能实体 base64),跨机器/跨平台整体搬家;导入幂等——github 按仓库去重重克隆、local 文件落库带路径穿越防护、项目 id 冲突换新 id、`activeProjectId` 与全局档案仅在本机空缺时采用。
- **收养既有 skills**(library.ts `adoptFromAgent` / `adoptFromAllAgents`):把 agent 用户级/项目级 skills 目录里已存在的 skills 收进中央库(跳过指向库内的 symlink 与同名条目),先纳管再统一分发;`adoptFromAllAgents` 一键扫描所有 agent(同名跨 agent 去重、同目录按 realpath 只扫一次、未安装/无目录记 skippedAgents 不报错);桌面 App 启动时(startServer)自动做用户级收养,打开即在技能库看到本机已配置的 skills。
- **AI 技能推荐**(`src/core/ai.ts`):填开发需求,模型(OpenAI 兼容 chat/completions)读本地技能库给出初步推荐供勾选绑定,**新建项目弹窗与项目详情页均可多次调用**;同时**联网搜 GitHub**——模型输出 githubKeywords(没给则用需求里的英文词兜底),按 `topic:agent-skills <关键词>` 搜仓库(复用 recommend 的 24h 缓存),去重、排除已入库、按 star 降序,可一键安装入库;本地与联网两路成败互相隔离(库空跳过模型只走联网;模型挂了仍有 GitHub 结果);配置存 `ai.json`(baseUrl/model/apiKey,预设 Kimi/DeepSeek/OpenAI/OpenRouter,baseUrl 可填中转站);未配置 key/断网/解析失败一律降级为 `{ items: [], github: [], message }` 不抛异常;CLI(`ssw ai`)、REST(`/api/ai/*`)、桌面 GUI(新建项目弹窗 + 项目详情「AI 推荐」区 + 设置弹窗)、TUI(i 键)均已接入。
- **快照回滚**:每次 apply 前在 `snapshots/<projectId>/` 建快照(全局共享用 `snapshots/__global__/`),每项目保留最近 5 份,`rollback` 逆序还原最近一次(skills 与 MCP 同一份快照,一起还原)。
- **热度排序选配**(`src/core/rank.ts`):给项目/全局共享选技能时,常用的排前面。三个信号加权:使用次数(绑定即计——`registry.markSkillsUsed` 挂在 updateProject/updateGlobal 的技能集差集上,只增不减,每次 +10)> 项目分类匹配(技术栈 + 项目名分词命中 skill 的 name/description/tags,每个 +6;`projectRankContext` 复用 recommend 的检测/分词口径)> 仓库 stars(安装/更新时 `fetchRepoStars` 采集,软失败;log10 压量纲 ×4)。`rankSkills` 稳定降序;REST `GET /api/skills?rank=1[&forProject=id]`(不带 rank 保持注册表原顺序,向后兼容)、GUI 两个"从库中添加"弹窗、AI 推荐载荷(stars/uses 作相关度 tie-break)均已接入;CLI `skill list` 与 TUI 技能库视图带 ★/用N 热度标记;重装/更新 skill 时 upsert 保留 useCount/stars 统计。
- **自动更新系统**(`src/core/update.ts`):对照 GitHub Releases 最新 release 检查新版本——版本比较只看 X.Y.Z 数字段(解析不了按更旧,坏 tag 不误报),6h 磁盘缓存(`cache/update-latest.json`)+ 并发在途去重,断网/限流降级 `{ ok:false, message }` 不抛异常。`pickAsset` 按平台挑安装包(win→Setup*.exe / mac→按 arch 匹配 dmg / linux→AppImage);下载流式写 `.part` 再原子改名落盘 `<SSW_HOME>/downloads/`(置可执行位),进度并入 `/api/progress`,同文件已下载幂等跳过。配置存 `update.json`(autoCheck 默认开 / autoDownload 默认关 / skillsAutoCheck 默认开 / skillsCheckIntervalHours 默认 6,收敛 1-168);桌面 App 启动时按配置自动检查(开自动下载则后台拉包),全静默。CLI(`ssw update`)、REST(`/api/update/*`)、桌面 GUI(设置弹窗 + 侧栏横幅)、TUI(U 键)均已接入。
- **技能库更新系统**(library.ts `checkLibraryUpdates` / `applyLibraryUpdates` / `getLastLibraryUpdates`):检查 github 来源 skills 的上游更新并一键更新。`groupGithubRepos` 按 owner/repo 分组(整仓一次 clone、多 skill 共享,仓库目录 `library/github__owner__repo`);逐仓 `git fetch --quiet` 后 `rev-list --count HEAD..@{u}` 得落后提交数(浅克隆无上游信息时兜底 `rev-parse` 比 sha);inflight 并发去重,单仓失败只记该仓 error、整体失败降级 `{ ok:false, message }` 不抛;结果存内存态。`applyLibraryUpdates(repoIds?)` 逐 skill 走 `updateSkill`(保留 useCount/stars),成功仓库即时把内存态 behind 清零。定时调度挂在 serve.ts(listen 后 15s 首查 + 按 `skillsCheckIntervalHours` 间隔,`setInterval(...).unref()`,全静默);REST(`/api/skills/updates*`)、CLI(`skill update --check`)、TUI(技能库 U 键)、桌面 GUI(技能库页提示条 + 一键更新 + 设置开关)均已接入。

两个前端共享同一个 TypeScript 核心引擎(`src/core/`),也共享同一份磁盘状态(`SSW_HOME`):

1. **Electron 桌面 App**:主进程内**进程内启动** Express(`127.0.0.1` + 随机空闲端口),不依赖外部 node 进程;单实例锁,窗口全关即退出;窗口加载 `public/` 单页应用。
2. **CLI(`ssw`,别名 `skills`)**:commander 实现,子命令纯命令行非交互,适合服务器;子命令完整映射 core 能力,全局 `--json` 输出。**不带参数启动(TTY 下)进入交互式终端面板**(`src/tui.ts`,零依赖:stdin raw 模式 + ANSI 渲染);非 TTY 裸跑打印帮助。

## 技术栈

- **语言/运行时**:TypeScript 5.7(strict)、Node.js(ESM,`"type": "module"`,`module: NodeNext`;CLI 单文件分发目标 Node ≥ 18)。
- **运行时依赖仅两个**:`express`(REST API + 静态托管)、`commander`(CLI)。不要轻率新增运行时依赖。
- **开发依赖**:typescript、vitest(测试)、electron + electron-builder(桌面打包)、esbuild(CLI 单文件打包)。
- 注意:**没有** zod、Octokit、Ink、React(PLAN.md 提到但未采用);SKILL.md frontmatter 用自写的单行 `key: value` 解析器(`src/core/library.ts` 的 `parseFrontmatter`),GitHub API 直接用全局 `fetch`。

## 构建与常用命令

```bash
npm install        # 安装依赖
npm run build      # 先清 dist/ 再 tsc 编译 src/ → dist/(避免旧重构残留的孤儿产物;声明与 sourcemap 均关闭);
                   #   最后 chmod 0o755 dist/cli.js——bin 软链需要可执行位,dist/ 每次被清重建会丢
npm test           # vitest run 全量测试
npm run app        # 编译 + electron . 起桌面窗口(需图形环境)
npm run dist       # 编译 + electron-builder,产出 Linux AppImage 到 release/
npm run dist:cli   # 编译 + esbuild 打包单文件 CLI → release/cli/ssw.mjs(零依赖)
npm run release    # 一键发布:干净工作区检查 → 全量测试 → 打 v<version> tag → push main+tag
                   #   (tag 触发 release.yml 三平台构建;防"合并后忘打 tag"——v1.3.0/v1.4.0~1.4.4 曾漏发)
```

CLI 本机使用:`npm run build` 后 `node dist/cli.js ...`(`package.json` 已注册 `bin: ssw`/`skills`)。图标用 `node scripts/make-icon.mjs` 重新生成(纯 Node 手写 PNG → `build/icon.png`)。**版本号只改 `package.json`**:CLI 经 `src/version.ts` 运行时读取自动跟随;单文件分发由 `scripts/build-cli.mjs` 在 esbuild 打包时 define 注入 `__SSW_VERSION__`。

## 目录结构与模块划分

```
src/
  core/                  # 核心引擎,不依赖任何前端;GUI/CLI/Electron 零改动复用
    paths.ts             # SSW_HOME 路径常量(含 globalFile、aiFile、updateFile、downloadsDir);每次调用重读环境变量(测试隔离的关键);
                         #   ensureSkeleton() 启动时建目录骨架(downloads/ 不在骨架里,真正下载时才建)
    types.ts             # SkillEntry(含 stars/useCount/lastUsedAt 热度字段) / McpEntry / Project / ProjectsData / ApplyMode
    registry.ts          # registry.json 读写;atomicWriteJson(tmp+rename 原子写,renameWithRetry 退避重试
                         #   Windows 杀软瞬时持锁的 EPERM;写完 chmod 0o600——ai.json/mcps.json 含密钥,
                         #   对齐各家 CLI 凭据文件惯例,Windows 上静默跳过)、readJsonSafe(损坏容错);
                         #   markSkillsUsed:绑定进项目/全局共享时 useCount+1、刷新 lastUsedAt(只增不减)
    library.ts           # 中央库:github→git clone --depth 1(可选 subdir 子目录为扫描根,registerSkillsIn 可单测;
                         #   subdir 只允许 '/' 分隔,显式拒绝 '\' 与 ':'——防 Windows 路径穿越到库外被递归删除;
                         #   未指定 subdir 且根级扫描落空时 registerSkillsWithFallback 自动探测
                         #   skills/.agents/skills/.claude/skills 常见合集子目录——联网推荐命中的合集仓库
                         #   多把 skills 收在子目录,只扫根级会误报"未找到合法 skill")、
                         #   local→复制、卸载、更新、initSkill 脚手架(可选 content:粘贴的完整 SKILL.md
                         #   剥原 frontmatter 重新生成,name/description 可由其兜底,显式参数优先);
                         #   adoptFromAgent:收养 agent 用户级/项目级目录里既有的 skills 进库
                         #   (跳过指向库内的 symlink 与同名条目,installFromLocal 的"已在库中"按跳过处理;
                         #   扫描循环抽为 adoptFromDir 供复用);adoptFromAllAgents:一键收养所有 agent
                         #   (user 级按 detect 过滤,目录不存在/同目录复扫记 skippedAgents 不报错,
                         #   同名跨 agent 去重,返回 scanned 分目录明细 + 扁平汇总);
                         #   git 调用统一走 runGit(spawn 流式读 stderr,返回 stdout):120s 超时(SSW_GIT_TIMEOUT_MS 覆盖)
                         #   + GIT_TERMINAL_PROMPT=0(禁交互式凭据提示,防 GUI/服务进程里看不到提示而永久"安装中")
                         #   + clone/pull --progress 进度段解析后兵分两路:TTY 渲染进度条到 stderr
                         #   (不污染 --json 的 stdout),同时写 gitProgress 内存表(listGitProgress)
                         #   供 GET /api/progress 轮询——桌面 GUI 的进度条数据源;
                         #   进度解析(parseProgressSegment/summarizeStderr,PROGRESS_LINE_RE)语言无关:
                         #   git 输出随界面语言本地化(zh_CN"接收对象中"),阶段名正则不匹配会解析不出
                         #   百分比、GUI 进度条不显示,错误摘要也会被进度行污染;
                         #   clone 失败清理残目录;
                         #   validateSkillDir 校验 SKILL.md frontmatter(name/description 必填);
                         #   skill 名校验含 Windows 保留名(CON/PRN 等)拒绝;
                         #   fetchRepoStars 采集仓库 stars(软失败,安装/update 时调用;installFromGithub
                         #   第三参 fetchImpl 可注入测试);registerSkillsIn/installFromLocal/initSkill 的
                         #   upsert 保留旧条目的 useCount/stars 统计;
                         #   sameRealPath 防自杀式复制(Windows/macOS 大小写、8.3 短名绕过纯字符串比较);LibraryError;
                         #   技能库更新:groupGithubRepos 按 owner/repo 分组 github 来源 skills
                         #   (仓库目录 library/github__owner__repo);checkLibraryUpdates 逐仓
                         #   git fetch --quiet 后 rev-list --count HEAD..@{u} 得落后提交数(浅克隆
                         #   无上游信息兜底 rev-parse 比 sha),inflight 并发去重,单仓失败记该仓
                         #   error、整体失败降级 { ok:false, message } 不抛,结果存内存态
                         #   (getLastLibraryUpdates);applyLibraryUpdates(repoIds?) 逐 skill 走
                         #   updateSkill,成功仓库即时把内存态 behind 清零
    projects.ts          # 项目档案 CRUD + activeProjectId;id 用 crypto.randomUUID();旧档案无 mcps 字段,读取兜底 []
    mcps.ts              # MCP server 中央注册表(mcps.json,纯配置无实体目录);name 即唯一键,
                         #   限定 ^[A-Za-z0-9_-]{1,64}$(Claude Code 限制 + codex TOML 段名免转义);
                         #   upsertMcp 按 transport 裁剪字段(远端不存 command 等);removeMcp 解除项目绑定;McpError
    apply.ts             # applyProject / unapplyProject:物化 skills + MCP 到各 agent 目录;Windows 上 symlink 用 junction(免管理员);
                         #   幂等(已是指向库的 symlink 或 SKILL.md 一致的 copy 副本则跳过);中途失败清理未 finalize 的空快照;
                         #   copy 物化落归属标记 .ssw-copy,unapply 的 copy 归属判定(isOurCopy)= 有标记,
                         #   或旧版无标记副本要求 SKILL.md 一致且无 src 之外的多余文件(防误删用户手工同名目录);
                         #   materializeSkills / removeMaterialized / resolveSkills 导出供 global.ts 复用
    apply-mcp.ts         # MCP 物化:合并写各 agent 项目级 MCP 配置;JSON 系(mcpServers)结构化合并 +
                         #   codex config.toml 块级文本合并([mcp_servers.*] 段,自写最小 TOML 生成/段删除,不引依赖);
                         #   已有文件先进快照再写,内容一致幂等跳过;unapply 只摘项目绑定的名字,
                         #   摘空(JSON 仅剩空 mcpServers / TOML 成空白)则删文件
    global.ts            # 全局(用户级)共享应用:global.json 档案(skills/agents/applyMode/lastAppliedAt,字段级容错),
                         #   applyGlobal/unapplyGlobal/rollbackGlobal;快照固定名 GLOBAL_SNAPSHOT_ID='__global__';
                         #   只管 skills 不管 MCP;CLI/REST/桌面 GUI/TUI 均已接线
    snapshot.ts          # 快照/回滚;MAX_SNAPSHOTS = 5;移动走 moveEntry:跨设备 EXDEV 降级 复制+删除(Windows 多盘符)
    recommend.ts         # 技术栈检测(package.json/go.mod/Cargo.toml/pyproject.toml)+ GitHub Search API;
                         #   searchGithubSkillsCached(query, fetchImpl):任意查询词的仓库搜索
                         #   (24h 缓存 cache/,sha1(query) 作文件名),ai.ts 联网推荐复用;
                         #   断网/限流降级返回 { items: [], message },绝不抛异常
    ai.ts                # AI 技能推荐:OpenAI 兼容 chat/completions 读本地技能库按需求挑技能(本地库推荐),
                         #   同时联网搜 GitHub 做库外推荐:模型输出 githubKeywords(parseAiGithubKeywords
                         #   清洗:小写/合法字符/2-40 字符/去重/≤3),没给则 fallbackGithubKeywords
                         #   取需求里的英文词(≥3 字符,≤2);searchGithubForRequirement 按
                         #   topic:agent-skills <kw> 搜仓(复用 recommend 的 24h 缓存),排除已入库、
                         #   去重、star 降序、上限 8(MAX_GITHUB_RECOMMENDATIONS);
                         #   本地与联网两路成败互相隔离:库空跳过模型只走联网,模型挂了仍有 GitHub 结果;
                         #   配置 ai.json(baseUrl/model/apiKey,字段级容错),AI_PRESETS 预设
                         #   Kimi/DeepSeek/OpenAI/OpenRouter,baseUrl 可填中转站(chatEndpoint 端点归一);
                         #   GET 只回掩码(toPublicConfig)不回 key 原文;超时 60s(SSW_AI_TIMEOUT_MS 覆盖);
                         #   extractJson 共享解析器,parseAiRecommendations 容忍围栏/裸数组/解释文字,
                         #   幻觉 id 丢弃,上限 8 个;testAiConnection 走同款最小 chat 请求(测过即推荐可用);
                         #   fetchImpl 可注入(测试);一切失败降级 { items: [], github: [], message } 不抛异常;
                         #   AiError(配置校验)映射 400;
                         #   aiExtractGithubKeywords:只提炼 GitHub 搜索英文关键词(不读技能库,
                         #   推荐库「AI 搜索」用;未配置 key/失败降级空 keywords,由调用方兜底直搜)
    rank.ts              # 热度排序:skillScore(使用次数×10 > 项目关键词匹配×6 > log10(stars)×4)+
                         #   rankSkills 稳定降序;projectRankContext 复用 detectTechStack + 项目名分词
    migrate.ts           # 迁移码:ssw1:owner/repo,... 仅含 github 来源,按仓库去重;
                         #   importSkillsCode 幂等跳过已有、单仓失败不中断;installFn 可注入(测试)
    profile.ts           # 配置库导出/导入:ssw-profile@1 bundle(skills+mcps+projects+global+local 技能实体 base64,
                         #   单 skill >20MB 跳过并告警);导入幂等(github 按仓重克隆+upsert 原条目保绑定、
                         #   local 落库带路径穿越防护、项目 id 冲突换新 id、activeProjectId/全局档案仅空缺时采用
                         #   且全部幂等跳过时也落盘);bundle 是外部输入:导入前全量预检条目 id/name
                         #   (assertSafeBundleEntry,口径同 assertValidSkillName/normalizeSubdir),
                         #   local 落盘目标追加"必须在库目录内"前缀断言双保险;
                         #   installFn 可注入(测试)
    catalog.ts           # 内置精选推荐库:111 个高 star skill 仓库 + 26 个常用 MCP server / 13 大类
                         #   (dev/research/writing/marketing/product/design/media/knowledge/data-ai/robotics/
                         #   devops/security/productivity,分类无空档);静态数据离线可用,stars 为收录时快照
                         #   (无公开仓库的托管 MCP 记 0);条目 subdir 适配合集仓库(skills/ 等子目录扫描根);
                         #   kind:'mcp' 条目的 mcp 载荷与 upsertMcp 对齐(env/headers 密钥为占位符),
                         #   installed 标记按 mcps.json 同名判断;listCatalogCategories() 分类统计
                         #   (count/skills/mcps)供 GUI 标签角标、CLI catalog categories、TUI 分类切换共用;
                         #   CatalogFilter.kind(catalogEntryKind 口径,缺省视为 skill)把 skills 与 MCP
                         #   的浏览/安装分流:REST ?kind=、CLI --kind、TUI k 键、GUI 类型标签页共用;
                         #   searchCatalogGithub(q, {ai, kind, fetchImpl}):联网搜 GitHub 仓库
                         #   (复用 recommend 24h 缓存,多词合并去重、star 降序、上限 12);
                         #   kind=skill 搜 topic:agent-skills,kind=mcp 搜 topic:mcp-server +
                         #   topic:model-context-protocol 一词两查(MCP 仓库不带 agent-skills
                         #   topic,旧口径搜不到 matlab-mcp-server 等);缺省自动判定——搜索词含
                         #   独立单词 mcp 即按 mcp 搜;裸 mcp/server 关键词不参与检索防泛化淹没;
                         #   installed 口径 skill 按注册表仓库前缀、mcp 按 suggestMcpName(仓库名)
                         #   比对 mcps.json;ai:true 先用 aiExtractGithubKeywords 提炼
                         #   英文词,失败/未配置降级需求英文词兜底、再不行整句直搜;
                         #   一切失败降级空+message 不抛;fetchGithubMcpConfig(repo):
                         #   MCP 的「下载」落地——从 README 的 ```json 围栏块提取
                         #   mcpServers/servers(VS Code 风格)启动配置(command/args/env 或
                         #   url/serverUrl+headers,type=sse 识别),多 server 优先与仓库名相近者;
                         #   repo 非法抛 McpError,网络/无配置块降级 spec:null+message 不抛
    doctor.ts            # 环境自检 runDoctor():数据目录可写/git 探活(spawn git --version,10s 超时)/
                         #   agent 检测(排除恒真的 'agents')/五个 JSON 数据文件健康度(缺失=首用 ok,
                         #   损坏=error 附修复 hint——运行时被 readJsonSafe 容错吞掉的损坏在这里暴露)+ 统计;
                         #   git 缺失与零 agent 检测只算 warn,ok = 无 error 级;CLI doctor / /api/doctor /
                         #   TUI d 键 / GUI 设置弹窗共用
    update.ts            # 软件更新:对照 GitHub Releases 检查新版本(compareVersions 只看 X.Y.Z,解析不了
                         #   按更旧);6h 磁盘缓存 cache/update-latest.json + inflight 并发去重 + lastResult
                         #   内存态;失败降级 { ok:false, message } 不抛(UpdateError 只用于配置校验/打开器
                         #   输入错误,映射 400);pickAsset 按 platform/arch 挑安装包(win→Setup*.exe,
                         #   mac→arm64/非 arm64 dmg,linux→AppImage);downloadUpdate 流式写 .part 再
                         #   renameWithRetry,落盘 downloads/(chmod 755 软失败),在途拒绝并发,同文件
                         #   已下载幂等;listUpdateProgress 合并进 /api/progress(GUI 进度条复用);
                         #   openExternal 只接受 https URL/绝对路径;autoUpdateOnStartup 按 update.json
                         #   配置启动自检+后台下载,全静默;UpdateConfig 另含技能库更新配置
                         #   skillsAutoCheck(默认 true)/skillsCheckIntervalHours(默认 6,保存时
                         #   收敛 1-168,读取容错),serve.ts 定时检查技能库用;
                         #   SSW_UPDATE_API(测试注入)/SSW_UPDATE_TIMEOUT_MS(默认 30s)env 覆盖
  adapters/
    types.ts             # AgentAdapter 接口(id/displayName/detect/projectSkillsDir/userSkillsDir/capabilities/mcp?);
                         #   userSkillsDir() 是全局共享 apply 的目标(用户级 skills 目录);
                         #   McpSupport = MCP 配置目标(format json|codex-toml + configPath + toServerConfig)
    factory.ts           # makeAdapter(spec):detect 依据 ~/<homeDir> 是否存在(可用 spec.detect 覆盖;
                         #   homeDir 支持多段如 '.codeium/windsurf'),项目级 skills 目录 = <项目根>/<skillsSubDir>,
                         #   用户级 = ~/<homeDir>/skills;
                         #   jsonMcpSupport():mcpServers JSON 系 MCP 支持快捷构造,remoteStyle 区分远端条目写法
                         #   (claude 带 type/http+sse,kimi sse 用 transport,plain 仅 url;withCwd 仅 kimi)
    claude-code.ts kimi-code.ts cursor.ts codex.ts qwen-code.ts trae.ts factory-droid.ts
                         # 声明 mcp 支持的七家(配置目标见上;qwen 远端 http 用 httpUrl 键、sse 用 url,
                         #   factory 条目带 type 字段,两家为自定义 toServerConfig;trae 用 jsonMcpSupport plain)
    agents.ts            # 通用目录 .agents/skills(开放规范互操作路径;非具体应用,detect 恒 true)
    gemini-cli.ts copilot.ts windsurf.ts opencode.ts roo-code.ts openclaw.ts deepseek-harness.ts
    cline.ts continue.ts crush.ts amp.ts
                         # 无 MCP 支持的十二家(apply MCP 时跳过并告警);copilot/opencode/openclaw/amp
                         #   项目级同指 .agents/skills;Goose/OpenHands/Grok CLI 因 skills 两级都走
                         #   .agents/skills 已被 agents 适配器覆盖,不单独设适配器
    index.ts             # adapters 注册表(19 个)+ getAdapter(id)
  server.ts              # Express 应用:createApp(),REST API + 托管 public/;统一错误格式 { "error": "..." };
                         #   回环防护中间件:Host 必须指向 127.0.0.1/localhost(防 DNS rebinding),
                         #   带跨站 Origin 的请求一律 403(防恶意网页 simple request 跨域打写端点);
                         #   写请求(非 GET/HEAD/OPTIONS)进程内串行化(core 读-改-写无锁,防 GUI 连点互相覆盖);
                         #   express.json limit 50mb(profile bundle 内嵌 base64,默认 100KB 会把导入 413 掉);
                         #   resolvePublicDir 从自身位置逐级上探(≤4 级)找 public/index.html,覆盖 dist/打包/单文件三布局;
                         #   GET /api/meta 暴露服务进程 cwd;POST /api/projects 的 path 缺省取 cwd;
                         #   /api/mcps CRUD + /api/projects/:id/mcps 绑定(校验名字在注册表存在);
                         #   /api/global GET/PUT + apply/unapply/rollback;/api/profile/export|import;
                         #   GET /api/catalog[?category=&q=&kind=skill|mcp]:推荐库,kind 把 skills 与 MCP 分流;
                         #   GET /api/catalog/github?q=<>&ai=1[&kind=skill|mcp]:推荐库联网搜索(q 必填 400;
                         #   ai=1 先 AI 提炼关键词;kind 缺省按搜索词含 mcp 与否自动判定;降级 200 + message);
                         #   GET /api/catalog/github/mcp-config?repo=<>:从仓库 README 提取 MCP 启动配置
                         #   (repo 必填;提取不到/断网 200 + spec:null + message;repo 非法 McpError 400);
                         #   GET /api/progress:git clone/pull + 更新下载任务进度(前端进度条轮询);
                         #   GET /api/skills?rank=1[&forProject=id] 热度排序(不带 rank 保持原顺序);
                         #   POST /api/skills/adopt 收养 agent 目录既有 skills;{ all: true } 一次
                         #   收养所有 agent(缺省 user 级,返回 scanned/skippedAgents 分明细);
                         #   /api/skills/updates:GET 读内存态(不发网络)、POST /check 立即检查、
                         #   POST /apply 一键更新(可选 repoIds 子集,非字符串数组 400);
                         #   PUT /api/update/config 兼收 skillsAutoCheck/skillsCheckIntervalHours;
                         #   /api/ai/config GET(掩码)/PUT、/api/ai/test(保存前可带表单值先测)、
                         #   /api/ai/recommend(requirement 必填,降级不抛错);
                         #   GET /api/doctor:环境自检报告(带 version,GUI 设置弹窗数据源);
                         #   /api/update/*:status(当前版本+配置+最近检查+下载任务,不发网络)、
                         #   check(强制刷新)、config PUT、download(202 异步;在途 409;同文件
                         #   已下载幂等 already;检查失败 502)、open(target release|download,
                         #   目标由服务端解析,只放行本项目 releases URL 与 downloads 目录)
  serve.ts               # startServer(port, host?) 启动函数:仅 Electron 主进程进程内调用(127.0.0.1+随机端口);
                         #   listen 前自动 adoptFromAllAgents(user 级)——打开 App 即在技能库看到本机
                         #   各 agent 已配置的 skills;失败静默降级不影响启动;
                         #   listen 后 fire-and-forget 调 autoUpdateOnStartup(按 update.json 自动检查/
                         #   自动下载更新,全静默);并按 skillsAutoCheck 调度技能库更新定时检查
                         #   (15s 首查 + 每 skillsCheckIntervalHours 一次,setInterval(...).unref()
                         #   不阻塞退出,全静默)
  cli.ts                 # ssw/skills 入口:全部子命令;id|name 寻址(id 精确优先,name 歧义列候选报错;
                         #   项目与 skill 都支持,skill 用名称简写免敲 local:x 长 id);
                         #   --json;无参数且 TTY 时动态 import tui.js 进终端面板,非 TTY 打印帮助;
                         #   project create / recommend 的 --path 缺省取当前工作目录;
                         #   project create 的 --agents 缺省取本机检测到的 agent(排除恒真 'agents',
                         #   零检测则报错引导);doctor 环境自检(error 级问题存在时退出码 1);
                         #   各安装/绑定命令成功输出带「下一步」引导;
                         #   mcp list/add/remove(--command 与 --url 二选一,--env/--header 逗号分隔 KEY=V,--cwd 仅部分 agent 支持;
                         #   mcp add --github <owner/repo> 从仓库 README 提取启动配置一键添加,--name 可省按仓库名推导,
                         #   提取不到报错并给手动指引)
                         #   + project bind-mcp;catalog install 按条目 kind 分流:skill 整仓安装,mcp 写注册表;
                         #   catalog 列表 --kind skill|mcp 把两类条目的浏览/安装分开(非法值报错);
                         #   catalog --q <词> --github 联网搜 GitHub(--ai 先提炼关键词,蕴含 --github;
                         #   --kind 与搜索词含 mcp 的自动判定决定搜 agent-skills 还是 MCP server 仓库;
                         #   不带 --q 报错;输出带仓库链接,安装/添加指引按仓库类型分流);
                         #   catalog categories 分类清单(count/skills/mcps 统计,--category 的 id 来源);
                         #   skill init [--name --desc] [--content 文本|--file 路径](粘贴现成 SKILL.md 均可);
                         #   skill list 带 ★stars/用N次 热度标记;
                         #   skill adopt --agent <id> | --all(一次收养所有 agent,分目录输出)[--user|--path];
                         #   skill update [名称] [--check]:--check 只检查不更新(列出落后仓库与提交数,
                         #   有可更新时退出码 1 并引导);不带参数更新全部(技能库更新系统);
                         #   global show/bind/agents/apply/unapply/rollback;
                         #   ai config [--preset/--base-url/--model/--api-key](不带选项=查看+预设清单)/ test /
                         #   recommend "<需求>" [--bind 项目](并入技能集),输出含 GitHub 联网推荐段;
                         #   project create --ai "<需求>" 创建即推荐并自动绑定;本地/联网两路都无结果退出码才非零;
                         #   profile export [--file](警告打 stderr)/ import <file>(导入 failed 非零时退出码 1);
                         #   update 软件更新:不带选项=强制检查并打印(发现新版本带发布页/安装包大小/
                         #   下一步引导);--download 下载安装包(TTY 进度条写 stderr);--open 打开发布页;
                         #   --auto-check|--auto-download|--skills-check on|off 写 update.json(纯本地,不发网络)
  tui.ts                 # 终端交互面板:项目列表(光标项目附技能/MCP 绑定摘要行)+ ↑↓/Enter/n/x/a/u/r/i/s/m/g/c/d/U/q
                         #   按键(n 新建项目:依次询问名称/路径/agents/模式/开发需求,字段与 GUI 新建项目弹窗同口径,
                         #   填了需求则 AI 推荐并整体绑定;x 删除项目档案:y 二次确认,只删档案不动磁盘文件;
                         #   g 全局共享视图内 a/u/r 作用于全局;推荐库视图内 c 循环切换分类过滤、
                         #   k 循环切换类型过滤——全部/仅 skills/仅 MCP,与分类过滤叠加,skills 与 MCP 分流;
                         #   推荐库视图内 / 联网搜 GitHub(直搜;k 键类型过滤为仅 MCP 时搜 MCP server 仓库,
                         #   搜索词含 mcp 也自动判定)、i AI 提炼关键词再搜,结果代替目录
                         #   列表展示(MCP 结果带 [MCP] 标记,底部指引按类型分流到 ssw mcp add --github),
                         #   x 清除(Esc 有结果先清结果);
                         #   i AI 推荐:readline 临时退出 raw 模式读一行需求,结果视图含本地库+GitHub 联网两段,
                         #   任一路有结果即进 ai 视图,a 全部并入光标项目;
                         #   d 环境自检视图(d 重跑);U 软件更新视图(进入即强制检查,U 重查;
                         #   下载与配置修改指向 CLI ssw update);技能库视图带 ★/用N 热度标记 +
                         #   可更新徽标(落后仓库数),视图内 U 键两步——先检查,有可更新再按 U
                         #   一键更新全部;技能库/MCP/推荐库只读);
                         #   stdin raw 模式 + ANSI 整帧重绘
  version.ts             # 版本号单一来源:运行时读 ../package.json(src/ 与 dist/ 都恰在根下一层);
                         #   esbuild 打包单文件时 define 注入 __SSW_VERSION__
electron/main.mjs        # Electron 主进程:动态 import dist/serve.js,127.0.0.1+端口 0,BrowserWindow 加载;
                         #   窗口最小 720×540(界面自适应的可用下限)
public/                  # 原生单页应用(index.html / app.js / style.css),无构建步骤;深/浅双主题:
                         #   CSS 变量在 style.css 顶部,选择存 localStorage(ssw-theme),
                         #   index.html head 内联脚本在首屏前恢复主题;
                         #   界面自适应纯 CSS 断点(style.css 末尾):≥1500px 主区放宽到 1200px;
                         #   ≤1100px 侧栏收窄 220px、视图按钮两行;≤860px 侧栏变顶部横条
                         #   (项目卡横向滚动、主区全宽);≤560px 表单/工具栏纵向堆叠;
                         #   新建项目弹窗与项目详情页均含「开发需求」AI 推荐区(可多次调用,结果存 state.aiBox
                         #   重绘后恢复;runAiRecommend+renderAiBox 共享渲染:本地推荐勾选绑定,
                         #   GitHub 联网推荐一键安装并绑定,已绑定/已入库禁用态);
                         #   设置弹窗含 AI 配置(预设/baseUrl/模型/Key + 测连)与「软件更新」区
                         #   (当前版本/检查更新/下载进度条/打开下载目录/autoCheck+autoDownload 开关
                         #   + 技能库自动检查 skillsAutoCheck 开关);
                         #   侧栏顶部更新横幅(#update-banner,发现新版本或下载完成时浮现,点击开设置弹窗,
                         #   数据源 refreshUpdateBanner → GET /api/update/status);
                         #   MCP 服务页每个 server 带「设置」按钮,弹窗编辑配置(名称锁定,POST /api/mcps 同名 upsert 保存);
                         #   「从库中添加技能」弹窗(项目/全局共享)添加后不关窗、该行按钮变「已添加」禁用态,
                         #   方便连续添加大量技能,点「关闭」/遮罩才退出(先本地入列再发请求,防连点互冲);
                         #   收养弹窗支持选「全部 agent」(选中自动切用户级,按 agent 分组展示结果);
                         #   推荐库搜索框旁「GitHub 搜索」「AI 搜索」按钮(GET /api/catalog/github,
                         #   类型标签页为仅 MCP 时按 MCP server 仓库搜),结果区块(state.catalogGithub)
                         #   渲染在目录上方:命中关键词/★/已安装标记/「仓库 ↗」外链;skill 卡片「安装」整仓克隆,
                         #   MCP 卡片「添加」先走 /api/catalog/github/mcp-config 读 README 配置、
                         #   开 MCP 弹窗预填(openMcpServerModal 第二参 prefill,含 _hint/_onSaved),
                         #   保存后卡片原地转「已添加」,离开视图清空;
                         #   技能库页工具栏「检查更新」「一键更新全部」按钮 + #sk-upd-bar 提示条
                         #   (进视图 GET /api/skills/updates 读内存态,检查 POST .../check,
                         #   更新 POST .../apply 后 loadAll 重绘,落后仓库数高亮)
scripts/                 # make-icon.mjs(生成图标)、build-cli.mjs(esbuild 打 CLI 单文件,注入 createRequire + __SSW_VERSION__)、
                         #   release.mjs(npm run release:干净工作区检查 → 全量测试 → 打 tag → push main+tag)
tests/                   # vitest,每文件对应一个 core 模块 + platform(Windows 专项)+ server(API)+ cli(端到端)
electron-builder.yml     # 打包配置:Linux AppImage + Windows NSIS(中文安装界面)+ macOS dmg/zip → release/,
                         #   只带 dist/ electron/ public/ package.json;图标 build/icon.png + build/icon.ico
.github/workflows/       # ci.yml(push/PR:三平台 × Node 18/20/22 编译+测试,npm ci 时 ELECTRON_SKIP_BINARY_DOWNLOAD=1)、
                         #   release.yml(v* tag 或手动:先测试,再三平台打包,产物传 GitHub Release)
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
- API 约定:REST + JSON,错误统一 `{ "error": "..." }`;`LibraryError`/`McpError`/`AiError`/`UpdateError` 映射 400,其余 500。

## 测试

- 框架:**vitest**(`vitest run`),配置在 `vitest.config.ts`:`environment: 'node'`、`pool: 'forks'`、`testTimeout: 20000`。
- 测试文件在 `tests/*.test.ts`,每个 core 模块一个对应文件,外加:`platform.test.ts`(Windows 专项:symlink EPERM 降级 copy、git 不在 PATH 的可读报错、Windows 保留名拒绝)、`server.test.ts`(起真实 HTTP 服务验证校验逻辑与 CLI 对齐)、`cli.test.ts`(端到端,用 `child_process` 跑**编译产物** `dist/cli.js`,`beforeAll` 里先自动跑 `npm run build`;Windows 上改用 `npm.cmd` 且必须带 `shell: true`——Node ≥18.20/20.12 起无 shell 直接 spawn `.cmd` 会抛 EINVAL,只换名字绕不过)。
- **隔离约定(必须遵守)**:测试在 `beforeEach` 里把 `process.env.SSW_HOME` 指向 `fs.mkdtemp` 临时目录,`afterEach` 里删除该环境变量并 `rm` 临时目录——绝不触碰真实 `~/.skills-switch`。涉及真实文件系统的测试保持串行(这也是 `pool: 'forks'` 的原因)。`global.test.ts` 额外用 `vi.spyOn(os, 'homedir')` 指到临时目录,绝不触碰真实 home。
- 网络相关测试注入假 `fetch`(`recommendForProject(path, name, fetchImpl)` 的第三参、`aiRecommendSkills({ ..., fetchImpl })` 与 `testAiConnection(overrides, fetchImpl)`),不打真实 GitHub/模型 API。
- 提交改动前跑 `npm test`,当前基线:**19 个文件 258 个用例全绿**。push/PR 由 `.github/workflows/ci.yml` 跑三平台 × Node 18/20/22。

## 安全注意事项

- 本工具的核心动作是**写用户机器上其它工具的配置目录**(`.claude/skills` 等):任何 apply(项目级与全局共享)必须先快照、可回滚;同名冲突不许直接覆盖,先移入快照。
- `unapply` 只删除"确定是我们创建的"内容:symlink 需指向库内;copy 目录需带归属标记 `.ssw-copy`(旧版无标记副本则要求与库内 `SKILL.md` 一致且无库外多余文件);MCP 只摘项目当前绑定的 server 名,用户在同文件里的其它条目一律保留。
- profile bundle 是**外部输入**:导入前全量预检条目 id/name(`assertSafeBundleEntry`),local 落盘目标断言在库目录内——恶意 bundle 的 `../../..` 不得穿越出库目录删写文件。
- REST 服务仅监听 127.0.0.1 且**无认证**是既定设计,但必须有回环防护:Host 头非回环(防 DNS rebinding)或 Origin 跨站(防恶意网页 simple request)一律 403;数据文件落盘 0600(`ai.json`/`mcps.json` 含密钥)。
- MCP apply 编辑的是用户可能手改过的配置文件(`.mcp.json`、`config.toml` 等):写前已有文件必进快照;JSON 损坏无法安全合并时原文件进快照、重写为仅含本项目条目并告警。
- `skill add --github` 会执行 `git clone` 到库目录;`skill update` 会 `git pull --ff-only`。git 调用默认 120s 超时(`SSW_GIT_TIMEOUT_MS` 覆盖)且 `GIT_TERMINAL_PROMPT=0`(私有/不存在仓库直接报错而不是挂起等凭据)。URI 经 `normalizeGithubUri` 白名单式解析,只接受 `owner/repo` 或完整 GitHub URL;`--subdir` 只允许 `/` 分隔(显式拒绝 `\` 与 `:`),防 Windows 路径穿越导致库外目录被递归删除。
- 桌面版 BrowserWindow 开 `contextIsolation: true`、`nodeIntegration: false`,服务仅监听 `127.0.0.1`。
- Express 服务**无认证**:仅由桌面 App 进程内启动(`startServer(port, '127.0.0.1')`),不暴露网卡;若未来重新开放独立 Web 模式,需自行限制监听范围或套带认证的反向代理。
- 不要把 `SSW_HOME` 指向的目录当作可信输入边界——它存放的就是本工具的全部状态,损坏时要容错而不是崩溃。
- AI 配置的 apiKey **明文存于** `ai.json`(落盘 0600 仅属主可读写,与各家 CLI 的凭据文件同级风险):服务仅监听 127.0.0.1,REST/日志/导出(profile bundle 不含 ai.json)都不得回传 key 原文,GET /api/ai/config 只回掩码。

每次修改界面或增加功能，要同步增加所有release版本功能,并在确认正确后直接提交，核心产品是appimage和cli，不需要做web，不增添功能的提交覆盖原版本即可，功能新增提交再迭代小版本，版本更新确认正确后自动推送到releases
