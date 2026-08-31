/**
 * 核心数据模型,字段与 PLAN.md 4.3/4.4 保持一致。
 */

/** registry.json 中每个 skill 一条 */
export interface SkillEntry {
  id: string;            // "owner/repo:path" 或 "local:<name>" 或 "init:<name>"
  name: string;
  description: string;
  source: { type: 'github' | 'skills-sh' | 'local'; uri: string };
  ref?: string;          // git commit/tag,用于更新跟踪
  tags: string[];        // 推荐匹配用
  installedAt: string;   // ISO 时间
  stars?: number;        // github 来源仓库的 star 数(安装/更新时采集,软失败缺失)
  useCount?: number;     // 被绑定进项目/全局共享的累计次数(热度排序信号)
  lastUsedAt?: string;   // 最近一次被绑定的 ISO 时间
}

/** projects.json 中的项目档案 */
export interface Project {
  id: string;            // 随机 id
  name: string;
  path: string;          // 项目根目录(绝对路径)
  agents: string[];      // ["claude-code", "kimi-code", ...]
  skills: string[];      // SkillEntry.id 列表
  mcps: string[];        // McpEntry.name 列表(旧档案无此字段,读取时兜底 [])
  applyMode: 'symlink' | 'copy';
  createdAt: string;
  lastAppliedAt?: string;
}

/** mcps.json 中每个 MCP server 一条;name 即唯一键(写入各 agent 配置时的 server 名) */
export interface McpEntry {
  name: string;                       // ^[A-Za-z0-9_-]{1,64}$(Claude Code 的限制,同时保证 codex TOML 无需转义)
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;                   // stdio:启动命令
  args?: string[];                    // stdio
  env?: Record<string, string>;       // stdio:注入子进程的环境变量
  cwd?: string;                       // stdio:子进程工作目录(仅支持的 agent 会带上)
  url?: string;                       // http/sse:远端端点
  headers?: Record<string, string>;   // http/sse:静态请求头
  addedAt: string;                    // ISO 时间
}

/** projects.json 顶层结构:项目列表 + 当前激活项目 */
export interface ProjectsData {
  activeProjectId: string | null;
  projects: Project[];
}

export type ApplyMode = 'symlink' | 'copy';
