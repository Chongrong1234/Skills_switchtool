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
}

/** projects.json 中的项目档案 */
export interface Project {
  id: string;            // 随机 id
  name: string;
  path: string;          // 项目根目录(绝对路径)
  agents: string[];      // ["claude-code", "kimi-code", ...]
  skills: string[];      // SkillEntry.id 列表
  applyMode: 'symlink' | 'copy';
  createdAt: string;
  lastAppliedAt?: string;
}

/** projects.json 顶层结构:项目列表 + 当前激活项目 */
export interface ProjectsData {
  activeProjectId: string | null;
  projects: Project[];
}

export type ApplyMode = 'symlink' | 'copy';
