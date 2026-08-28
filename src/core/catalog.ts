/**
 * catalog 内置精选推荐库:静态数据(收录时的 stars 快照,仅供排序参考,以 GitHub 实时数据为准),
 * 离线可用;安装走 library 的 github 流程(POST /api/skills 或 ssw skill add --github)。
 */
import { readRegistry } from './registry.js';

export interface CatalogCategory {
  id: string;
  name: string; // 显示名(CLI/TUI 用)
}

export interface CatalogEntry {
  id: string;          // "owner/repo"
  name: string;
  description: string;
  stars: number;       // 收录时快照
  url: string;         // https://github.com/<id>
  category: string;    // CATALOG_CATEGORIES 中的 id
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { id: 'dev', name: '软件开发' },
  { id: 'research', name: '科研' },
];

/** 内置精选目录(stars 为收录时快照量级,不实时) */
export const CATALOG: CatalogEntry[] = [
  { id: 'vercel-labs/skills', name: 'skills', description: 'Agent Skills 事实安装标准 CLI(npx skills)', stars: 30000, url: 'https://github.com/vercel-labs/skills', category: 'dev' },
  { id: 'stanfordnlp/dspy', name: 'DSPy', description: '斯坦福的 LLM 编程框架,适合提示工程研究与实验', stars: 25000, url: 'https://github.com/stanfordnlp/dspy', category: 'research' },
  { id: 'anthropics/skills', name: 'Anthropic Skills', description: 'Anthropic 官方 skills 示例集', stars: 20000, url: 'https://github.com/anthropics/skills', category: 'dev' },
  { id: 'obra/superpowers', name: 'Superpowers', description: 'Claude Code 超能力技能集(规划/调试/协作工作流)', stars: 15000, url: 'https://github.com/obra/superpowers', category: 'dev' },
  { id: 'wshobson/agents', name: 'Agents', description: 'Claude Code 子代理与技能大集合(按职能分类)', stars: 15000, url: 'https://github.com/wshobson/agents', category: 'dev' },
  { id: 'hesreallyhim/awesome-claude-code', name: 'Awesome Claude Code', description: 'Claude Code 生态精选列表(含大量 skills 索引)', stars: 15000, url: 'https://github.com/hesreallyhim/awesome-claude-code', category: 'dev' },
  { id: 'VoltAgent/awesome-claude-code-subagents', name: 'Awesome Subagents', description: '子代理精选集,覆盖前后端/测试/运维等职能', stars: 8000, url: 'https://github.com/VoltAgent/awesome-claude-code-subagents', category: 'dev' },
  { id: 'davila7/claude-code-templates', name: 'Claude Code Templates', description: 'Claude Code 模板/命令/agents 集合', stars: 8000, url: 'https://github.com/davila7/claude-code-templates', category: 'dev' },
  { id: 'futurehouse/paper-qa', name: 'Paper QA', description: '科研论文问答工具(文献检索与证据抽取),适合文献调研', stars: 6000, url: 'https://github.com/futurehouse/paper-qa', category: 'research' },
  { id: 'affaan-m/everything-claude-code', name: 'Everything Claude Code', description: 'Claude Code 用法大全(含 skills 实践)', stars: 5000, url: 'https://github.com/affaan-m/everything-claude-code', category: 'dev' },
  { id: 'ComposioHQ/awesome-claude-skills', name: 'Awesome Claude Skills', description: 'Claude skills 精选列表', stars: 5000, url: 'https://github.com/ComposioHQ/awesome-claude-skills', category: 'dev' },
  { id: 'xingkongliang/skills-manager', name: 'Skills Manager', description: '库中心化 skills 图形管理器(竞品参考)', stars: 4200, url: 'https://github.com/xingkongliang/skills-manager', category: 'dev' },
  { id: 'gptme/gptme', name: 'gptme', description: '终端 AI agent,自带 skills 机制与示例技能', stars: 4000, url: 'https://github.com/gptme/gptme', category: 'dev' },
  { id: 'jupyterlab/jupyter-ai', name: 'Jupyter AI', description: 'JupyterLab 的 AI 助手(数据分析/ notebooks 场景)', stars: 3000, url: 'https://github.com/jupyterlab/jupyter-ai', category: 'research' },
  { id: 'qufei1993/skills-hub', name: 'Skills Hub', description: 'skills 集中管理与分发工具(竞品参考)', stars: 1200, url: 'https://github.com/qufei1993/skills-hub', category: 'dev' },
  { id: 'sokartema/adam-skill', name: 'ADaM Skill', description: '临床数据 ADaM 数据集处理技能(医药科研数据方向)', stars: 100, url: 'https://github.com/sokartema/adam-skill', category: 'research' },
];

export interface CatalogFilter {
  category?: string;
  query?: string;
}

/** 过滤 + 排序:默认按 stars 降序;query 大小写不敏感匹配 name/description/id */
export function listCatalog(filter: CatalogFilter = {}): CatalogEntry[] {
  let items = [...CATALOG].sort((a, b) => b.stars - a.stars);
  if (filter.category) items = items.filter((e) => e.category === filter.category);
  if (filter.query) {
    const q = filter.query.toLowerCase();
    items = items.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q),
    );
  }
  return items;
}

export interface CatalogEntryWithInstalled extends CatalogEntry {
  installed: boolean;
  installedCount: number; // 库中该仓库的条目数(一个仓库可含多个 skill)
}

/** 附加安装标记:registry 中 id 以 "<owner/repo>:" 开头的条目即视为已安装(大小写不敏感) */
export async function listCatalogWithInstalled(filter: CatalogFilter = {}): Promise<CatalogEntryWithInstalled[]> {
  const registry = await readRegistry();
  return listCatalog(filter).map((e) => {
    const prefix = `${e.id.toLowerCase()}:`;
    const count = registry.filter((s) => s.id.toLowerCase().startsWith(prefix)).length;
    return { ...e, installed: count > 0, installedCount: count };
  });
}
