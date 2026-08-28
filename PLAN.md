# Skills SwitchTool 项目计划书

> **目标(一句话):** 一个"项目中心化"的 Agent Skills 管理工具——用户创建项目、一键配置技能集、一键切换项目，无需挨个 agent 重复配置。

**架构:** 单一核心引擎(TypeScript 库）承担所有状态与文件操作，CLI/TUI 与后续 GUI 都只是它的前端。中央库存放全部 skills（唯一事实来源），项目档案记录"项目 ↔ 技能集 ↔ 目标 agents"绑定，切换项目 = 把对应技能集应用到各 agent 的项目级配置目录。

**技术栈:** TypeScript + Commander.js(CLI) + Ink(TUI) + zod（模式校验） + Octokit(GitHub API) + Vitest（测试）;GUI 阶段引入 Tauri + React。

**调研依据:** 截至 2026-08 的生态调研——SKILL.md 已成事实标准（agentskills.io),`npx skills`(vercel-labs/skills，约 30k★）是事实安装标准；GUI 管理器已有一批（xingkongliang/skills-manager 约 4.2k★、qufei1993/skills-hub 约 1.2k★ 等），但全部是"库中心化"，**"按项目自动套用技能集 + 创建项目智能推荐"是确认过的生态空白**，即本工具的差异点。

---

## 全局约束

- 全部状态目录：`~/.skills-switch/`（库、注册表、项目档案、快照、缓存）
- 项目内清单文件：`<项目根>/.skills-switch.json`（可提交 git，供团队对齐）
- 默认应用策略：symlink（改动即时生效）；Windows 无权限时自动降级 copy 并告警
- 任何写入 agent 配置目录的操作必须先做快照，支持一键回滚
- 离线可用：推荐索引有本地缓存，网络不可用时降级为仅本地库操作
- 支持平台：macOS / Linux / Windows

---

## 1. 背景与机会

- Agent Skills(SKILL.md + YAML frontmatter）已被 Claude Code、Codex、Cursor、Copilot、Kimi Code 等主流 agent 采用，内容库爆发式增长。
- 现有工具分两类：CLI 安装器（`npx skills`，无项目 profile 概念）和 GUI 库管理器（中央库 + 同步到工具，切换靠手动点选）。
- **用户痛点：** 不同项目需要不同技能集，现有方案要么"装的时候就固定"，要么"手动切预设"；发现优质 skills 要去 awesome 列表里翻，创建新项目时从零配置成本高。

## 2. 产品定位

**项目中心化（project-centric）的 skills 工作台。** 与现有"库中心化"工具的根本差异：项目是一等公民。

- 目标：创建项目即推荐、点一次配置完、切换项目技能集跟着走、用户能造自己的 skills。
- 非目标（v1 不做）:skills 内容市场本身、企业级审核/签名治理、agent hooks 的深度编排。

## 3. 核心功能需求

| 编号 | 功能 | 验收标准 |
|---|---|---|
| FR-1 | 项目管理 | `create/list/switch/remove`；创建时绑定目录与目标 agents；switch 后该项目技能集即时生效 |
| FR-2 | 中央库 | 从 GitHub 仓库 / skills.sh / 本地路径安装；list/update/remove；保留来源与版本 |
| FR-3 | 一键配置 | 为项目勾选 skills + agents 后，一次 apply 写入所有目标 agent 的项目级 skills 目录 |
| FR-4 | 自建 skills | `skill init` 脚手架生成合法 SKILL.md(frontmatter 校验）；校验通过一键入中央库 |
| FR-5 | 智能推荐 | 创建项目时检测技术栈（package.json/go.mod/Cargo.toml/pyproject.toml)，结合项目描述，返回按 star 排序的推荐列表，可勾选直接加入 |
| FR-6 | 快照回滚 | 每次 apply 前快照目标目录；`rollback` 恢复到上一次状态 |

## 4. 技术方案

### 4.1 形态决策：核心引擎 + CLI/TUI 先行，GUI 后置

现有竞品（Tauri GUI）证明了 GUI 的价值，但也证明 GUI 不是壁垒——功能内核才是。先交付 CLI/TUI 可最快验证"项目切换"核心体验，引擎与界面分离后，M4 用 Tauri 套壳不重写逻辑。

### 4.2 目录结构（文件职责）

```
src/
├── core/
│   ├── library.ts      # 中央库:安装/卸载/更新 skills(唯一事实来源)
│   ├── registry.ts     # registry.json 读写(zod 校验)
│   ├── projects.ts     # 项目档案 CRUD + switch 编排
│   ├── apply.ts        # 把技能集物化到 agent 目录(symlink/copy)+ 快照
│   ├── snapshot.ts     # 快照/回滚
│   └── recommend.ts    # 推荐引擎(技术栈检测 + 索引匹配)
├── adapters/
│   ├── types.ts        # AgentAdapter 接口
│   ├── claude-code.ts  # .claude/skills
│   ├── kimi-code.ts    # .kimi-code/skills
│   ├── cursor.ts       # .cursor/skills
│   └── codex.ts        # .codex/skills
├── cli/                # Commander 命令定义,只做参数解析,调 core
├── tui/                # Ink 交互界面(项目切换、技能勾选)
└── index.ts
```

每个文件单一职责；core 不依赖 cli/tui，保证 GUI 阶段零改动复用。

### 4.3 数据模型（zod schema)

```typescript
// ~/.skills-switch/registry.json —— 库中每个 skill 一条
interface SkillEntry {
  id: string;            // "owner/repo:path" 或 "local:<name>"
  name: string;
  description: string;
  source: { type: 'github' | 'skills-sh' | 'local'; uri: string };
  ref?: string;          // git commit/tag,用于更新跟踪
  tags: string[];        // 推荐匹配用
  installedAt: string;   // ISO 时间
}

// ~/.skills-switch/projects.json —— 项目档案
interface Project {
  id: string;            // ulid
  name: string;
  path: string;          // 项目根目录(绝对路径)
  agents: string[];      // ["claude-code", "kimi-code", ...]
  skills: string[];      // SkillEntry.id 列表
  applyMode: 'symlink' | 'copy';
  createdAt: string;
  lastAppliedAt?: string;
}
```

项目根目录的 `.skills-switch.json` 是上述 Project 的精简版（agents + skills)，提交进 git，队友克隆后 `ssw apply` 即对齐（借鉴 skillfish 清单思路）。

### 4.4 Agent 适配器契约

```typescript
// src/adapters/types.ts
interface AgentAdapter {
  id: string;                    // "claude-code"
  displayName: string;
  detect(): boolean;             // 本机是否装了该 agent
  projectSkillsDir(projectPath: string): string;  // 项目级 skills 目录
  capabilities: { hooks: boolean; allowedTools: boolean };  // 能力声明
  validate?(skill: SkillEntry): string[];          // 返回不兼容告警
}
```

v1 适配矩阵（M1 两个，M2 补齐）:Claude Code(`.claude/skills`)、Kimi Code(`.kimi-code/skills`)、Cursor、Codex。能力差异（如 `allowed-tools` 只有部分 agent 支持）通过 `capabilities` 声明 + `validate()` 告警处理，引擎只负责文件同步，不做能力抹平。

### 4.5 推荐引擎（FR-5)

1. **技术栈检测：** 扫项目根的清单文件（package.json → node/ts,go.mod → go,Cargo.toml → rust,pyproject.toml → python)，加上用户创建项目时填的一句话描述提取关键词。
2. **数据源（多源 + 本地缓存）:** skills.sh 目录 API、GitHub Search API(`topic:agent-skills` 类查询）、内置一份 awesome 列表种子索引；结果合并去重后按 star 降序，缓存到 `~/.skills-switch/cache/`(TTL 24h)。
3. **匹配：** 技术栈标签命中加权 + 关键词模糊匹配 + stars 排序，返回 Top 10，勾选即入库并绑定当前项目。

## 5. 里程碑

### M1 — 核心引擎 + CLI(最小可用闭环）
- 任务：registry/library/projects/apply/snapshot 五个 core 模块 + `claude-code`、`kimi-code` 两个适配器 + CLI(`project create/list/switch`、`skill add/list/remove`、`apply`、`rollback`)。
- 验收：临时目录模拟两个 agent 目录，创建项目 → 绑定 2 个 skills → switch → 断言两侧目录出现正确 symlink → rollback → 断言还原。Vitest 全绿。

### M2 — TUI + 适配器扩展
- 任务：Ink 交互界面（项目列表切换、技能勾选面板）;cursor/codex 适配器；`skill init` 脚手架 + frontmatter 校验（FR-4 落地）。
- 验收：全程无命令行参数完成"建项目→勾选→切换"；非法 SKILL.md 被校验拦截并给出可读错误。

### M3 — 推荐引擎（FR-5)
- 任务：技术栈检测、skills.sh + GitHub 双源抓取、缓存与降级、推荐勾选流。
- 验收：在一个 node 项目上 `project create` 能列出按 star 排序的推荐并一键加入；断网时降级为本地索引，不报错。

### M4 — GUI + 团队对齐
- 任务：Tauri + React 壳（复用 core，不重写逻辑）;`.skills-switch.json` 团队清单的导入导出。
- 验收：GUI 完成 FR-1~FR-5 全流程；队友克隆项目后一条命令对齐技能集。

## 6. 风险与对策

- **agent 格式演进：** SKILL.md 高级字段支持不一 → 适配器 `capabilities` 声明 + `validate()` 告警，引擎不强行兼容。
- **推荐源不稳定：** skills.sh/GitHub API 限流或变更 → 多源 + 24h 本地缓存 + 内置种子索引兜底。
- **Windows symlink 权限：** 自动降级 copy，并在 `apply` 输出中明确提示"改动库后需重新 apply"。
- **同质化竞争：** 不做大而全的库管理器，所有设计取舍围绕"项目切换"和"创建即推荐"两个差异点。

## 7. 验证策略

- 单测：Vitest,core 各模块 + 每个适配器的 fixture 测试（预置目录树快照对比）。
- e2e：临时目录沙盒跑完整 CLI 流程（create → bind → switch → rollback)，断言文件系统最终状态。
- 每个里程碑结束跑全量测试 + 手工过一遍验收标准，再进下一个。
