/**
 * catalog 内置精选推荐库:静态数据(收录时的 stars 快照,仅供排序参考,以 GitHub 实时数据为准),
 * 离线可用;安装走 library 的 github 流程(POST /api/skills 或 ssw skill add --github)。
 *
 * 收录标准(2026-08 经 GitHub API + 仓库 tarball/git tree 逐一校验):
 * - 仓库真实存在,stars 取校验时实际值;
 * - 必须能被 installFromGithub 消费:根/第一层子目录含 SKILL.md,或 skills 集中在某个
 *   子目录下(条目用 subdir 指明,安装时以该子目录为扫描根,见 library.registerSkillsIn);
 * - 纯 awesome 索引类仓库(无 SKILL.md)不收录;单仓 skill 数量过大的合集酌情标注。
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
  subdir?: string;     // skills 集中在仓库子目录时指明扫描根(合集仓库常见 "skills/")
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { id: 'dev', name: '软件开发' },
  { id: 'research', name: '科研' },
  { id: 'writing', name: '写作' },
  { id: 'marketing', name: '营销增长' },
  { id: 'design', name: '设计' },
  { id: 'data-ai', name: '数据与 AI' },
  { id: 'devops', name: 'DevOps 运维' },
  { id: 'productivity', name: '效率办公' },
];

/** 内置精选目录(stars 为 2026-08 校验时快照,不实时) */
export const CATALOG: CatalogEntry[] = [
  // ---- 软件开发 ----
  { id: 'obra/superpowers', name: 'Superpowers', description: '软件开发方法论工作流:头脑风暴、TDD、系统化调试、计划执行、代码评审等 14 个技能', stars: 278961, url: 'https://github.com/obra/superpowers', category: 'dev', subdir: 'skills' },
  { id: 'anthropics/skills', name: 'Anthropic 官方技能集', description: 'Anthropic 官方出品:docx/pptx/pdf 文档处理、前端设计、MCP 构建、skill 编写等 19 个技能', stars: 172238, url: 'https://github.com/anthropics/skills', category: 'dev', subdir: 'skills' },
  { id: 'DietrichGebert/ponytail', name: 'Ponytail', description: '让 AI 像"最懒的资深开发"一样思考:代码审计、技术债识别、精简与评审技能', stars: 115071, url: 'https://github.com/DietrichGebert/ponytail', category: 'dev', subdir: 'skills' },
  { id: 'thedotmack/claude-mem', name: 'claude-mem', description: '跨会话持久记忆:自动捕获会话上下文,压缩存档,新会话无缝续作', stars: 92489, url: 'https://github.com/thedotmack/claude-mem', category: 'dev', subdir: 'plugin/skills' },
  { id: 'addyosmani/agent-skills', name: 'Agent Skills(工程实践)', description: '生产级工程技能 24 个:API 设计、代码评审、CI/CD 自动化、调试恢复、前端工程、依赖治理等', stars: 90463, url: 'https://github.com/addyosmani/agent-skills', category: 'dev', subdir: 'skills' },
  { id: 'Egonex-AI/Understand-Anything', name: 'Understand Anything', description: '把任意代码库变成交互式知识图谱:解释、上手、对比、Figma 联动等 9 个技能', stars: 80860, url: 'https://github.com/Egonex-AI/Understand-Anything', category: 'dev', subdir: 'understand-anything-plugin/skills' },
  { id: 'vercel-labs/skills', name: 'skills(Vercel)', description: 'Agent Skills 生态官方安装工具(npx skills);附 find-skills 技能', stars: 29880, url: 'https://github.com/vercel-labs/skills', category: 'dev', subdir: 'skills' },
  { id: 'tt-a1i/archify', name: 'Archify', description: '生成美观且可校验的架构图、工作流图、时序图、数据流图', stars: 26579, url: 'https://github.com/tt-a1i/archify', category: 'dev' },
  { id: 'DenisSergeevitch/agents-best-practices', name: 'Agents Best Practices', description: '厂商中立的 agent 与 harness 设计最佳实践(单技能)', stars: 2249, url: 'https://github.com/DenisSergeevitch/agents-best-practices', category: 'dev' },

  // ---- 科研 ----
  { id: 'K-Dense-AI/scientific-agent-skills', name: 'Scientific Agent Skills', description: '把 AI agent 变成 AI 科学家:生物信息(biopython/单细胞)、天文(astropy)、文献检索、实验平台集成等 163 个技能', stars: 36229, url: 'https://github.com/K-Dense-AI/scientific-agent-skills', category: 'research', subdir: 'skills' },
  { id: 'brycewang-stanford/Auto-Empirical-Research-Skills', name: 'Auto Empirical Research', description: '斯坦福实证研究技能:全流水线旗舰条目(Python/R/Stata 版)与论文写作', stars: 3587, url: 'https://github.com/brycewang-stanford/Auto-Empirical-Research-Skills', category: 'research', subdir: 'skills' },
  { id: 'xuzhougeng/wisp-science', name: 'Wisp Science', description: '本地优先的 AI 科研工作台技能:文献证据审计、分析工作流等 34 个技能', stars: 1060, url: 'https://github.com/xuzhougeng/wisp-science', category: 'research', subdir: 'skills' },

  // ---- 写作 ----
  { id: 'blader/humanizer', name: 'Humanizer', description: '去除文本中的 AI 写作痕迹,让表达更自然(单技能)', stars: 38553, url: 'https://github.com/blader/humanizer', category: 'writing' },

  // ---- 营销增长 ----
  { id: 'coreyhaines31/marketingskills', name: 'Marketing Skills', description: '营销增长技能 50 个:CRO、文案、SEO、广告投放、数据分析、冷邮件、竞品分析等', stars: 45967, url: 'https://github.com/coreyhaines31/marketingskills', category: 'marketing', subdir: 'skills' },

  // ---- 设计 ----
  { id: 'cathrynlavery/diagram-design', name: 'Diagram Design', description: '38 种编辑级图表类型,自包含 HTML+SVG 输出,零依赖', stars: 28273, url: 'https://github.com/cathrynlavery/diagram-design', category: 'design', subdir: 'skills' },
  { id: 'JimLiu/baoyu-design', name: 'Baoyu Design', description: '宝玉的 Claude Design 本地化技能:生成精致设计稿', stars: 3628, url: 'https://github.com/JimLiu/baoyu-design', category: 'design', subdir: 'skills' },
  { id: 'bergside/typeui', name: 'TypeUI', description: '用 AI 构建更好的 UI:设计基础技能', stars: 1836, url: 'https://github.com/bergside/typeui', category: 'design', subdir: 'skills' },
  { id: 'zanwei/design-dna', name: 'Design DNA', description: '从参考 UI(截图/图片/URL)提取量化设计 DNA:tokens、配色、排版(单技能)', stars: 1555, url: 'https://github.com/zanwei/design-dna', category: 'design' },
  { id: 'LottieFiles/motion-design-skill', name: 'Motion Design', description: 'LottieFiles 出品动效设计原则:时序、缓动、编舞与迪士尼十二原则', stars: 1432, url: 'https://github.com/LottieFiles/motion-design-skill', category: 'design', subdir: 'skills' },
  { id: 'nateherkai/scroll-craft', name: 'Scroll Craft', description: '高端滚动叙事网站:滚动即时间轴的视觉叙事技能', stars: 1144, url: 'https://github.com/nateherkai/scroll-craft', category: 'design', subdir: 'plugins' },

  // ---- 数据与 AI ----
  { id: 'Kaelio/ktx', name: 'ktx', description: '数据与分析 agent 的可执行上下文层(Claude Code/Codex 等通用)', stars: 1564, url: 'https://github.com/Kaelio/ktx', category: 'data-ai', subdir: 'skills' },

  // ---- DevOps 运维 ----
  { id: 'kubesphere/kubesphere', name: 'KubeSphere', description: 'K8s 多云容器平台官方技能集 32 个:集群、应用、可观测性运维', stars: 17032, url: 'https://github.com/kubesphere/kubesphere', category: 'devops', subdir: 'skills' },
  { id: 'antonbabenko/terraform-skill', name: 'Terraform Skill', description: 'Terraform/OpenTofu 技能:测试、模块、CI/CD 与生产模式(antonbabenko 出品)', stars: 2309, url: 'https://github.com/antonbabenko/terraform-skill', category: 'devops', subdir: 'skills' },

  // ---- 效率办公 ----
  { id: 'googleworkspace/cli', name: 'Google Workspace CLI', description: 'Google Workspace 自动化技能 95 个:Drive/Gmail/日历/文档/表格/Chat/Classroom', stars: 30617, url: 'https://github.com/googleworkspace/cli', category: 'productivity', subdir: 'skills' },
  { id: 'virgiliojr94/book-to-skill', name: 'Book to Skill', description: '把任意技术书 PDF 变成可学习、可引用的 skill(单技能)', stars: 26599, url: 'https://github.com/virgiliojr94/book-to-skill', category: 'productivity' },
  { id: 'OthmanAdi/planning-with-files', name: 'Planning with Files', description: '文件式持久规划:计划落盘,长任务上下文丢失也能无缝续作', stars: 26404, url: 'https://github.com/OthmanAdi/planning-with-files', category: 'productivity', subdir: 'skills' },
  { id: 'huytieu/COG-second-brain', name: 'COG Second Brain', description: '自进化第二大脑:日记、日报、自动研究、内容工厂等 33 个技能闭环', stars: 1138, url: 'https://github.com/huytieu/COG-second-brain', category: 'productivity', subdir: 'skills' },
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
