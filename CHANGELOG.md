# 更新日志

本项目遵循语义化版本;版本号单一来源是 `package.json`。
发布走 `npm run release`(干净工作区检查 → 全量测试 → 打 tag → 推送,tag 触发三平台 Release 构建)。

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
