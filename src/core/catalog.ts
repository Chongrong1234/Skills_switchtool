/**
 * catalog 内置精选推荐库:静态数据(收录时的 stars 快照,仅供排序参考,以 GitHub 实时数据为准),
 * 离线可用。两类条目:
 * - skill 仓库(缺省):安装走 library 的 github 流程(POST /api/skills 或 ssw skill add --github);
 * - MCP server(kind: 'mcp',常用软件):安装即把 mcp 载荷写入中央注册表(POST /api/mcps 或
 *   ssw mcp add),env/headers 里的密钥是占位符,需用户自行替换。
 * 两类条目在数据里混排,浏览/下载按 kind 分流:listCatalog 的 filter.kind、REST ?kind=、
 * CLI --kind、TUI k 键、GUI 类型标签页共用同一过滤口径(catalogEntryKind,缺省 kind 视为 skill)。
 *
 * 收录标准(2026-08 经 GitHub API + 仓库 tarball/git tree 逐一校验):
 * - 仓库真实存在,stars 取校验时实际值;无公开仓库的官方托管 MCP(如 Linear)stars 记 0,前端不显示 ★;
 * - 必须能被 installFromGithub 消费:根/第一层子目录含 SKILL.md,或 skills 集中在某个
 *   子目录下(条目用 subdir 指明,安装时以该子目录为扫描根,见 library.registerSkillsIn);
 *   注意文件名必须是精确的 SKILL.md——全小写 skill.md 的仓库(如 Graphify-Labs/graphify)不收录;
 * - 纯 awesome 索引类仓库(无 SKILL.md)不收录(如 multica-ai/andrej-karpathy-skills 仅单份 CLAUDE.md);
 *   单仓 skill 数量过大的合集(如 TerminalSkills/skills 约千个、wondelai/skills 190+)酌情收录并在描述里标注;
 *   超大聚合仓(如 sickn33/agentic-awesome-skills 6600+)不收录;
 * - skills 在二级类目目录下、无单一可用扫描根的仓库不收录
 *   (如 trailofbits/skills、microsoft/agent-skills、phuryn/pm-skills、wshobson/agents、dotnet/skills、
 *   gamedev-skills/awesome-gamedev-agent-skills、Orchestra-Research/AI-Research-SKILLs、
 *   SnailSploit/Claude-Red、BagelHole/DevOps-Security-Agent-Skills、alirezarezvani/claude-skills、
 *   seb1n/awesome-ai-agent-skills、SamurAIGPT/Generative-Media-Skills、google-labs-code/stitch-skills)。
 * MCP 条目标准:npm 包名/远端端点经 npm registry 与官方文档逐一核验(2026-08),优先官方与官方托管;
 * 托管端点核验方式为探测其存活(401/400 即服务在线),密钥一律占位符。
 *
 * searchCatalogGithub:推荐库的联网搜索——分两类仓库:
 * - skill(缺省):按 `topic:agent-skills <关键词>` 搜(复用 recommend 的 24h 缓存);
 * - mcp:按 `topic:mcp-server` / `topic:model-context-protocol` 搜(MCP server 仓库不带 agent-skills
 *   topic,旧口径搜不到——例如官方的 matlab/matlab-mcp-server);搜索词含独立单词 mcp 时自动按 mcp 搜,
 *   也可由调用方显式传 kind(GUI 类型标签页/CLI --kind/TUI k 键)。
 * 结果带仓库链接,已入库(skill 按注册表前缀、mcp 按建议 server 名比对 mcps.json)只标记 installed 不排除;
 * ai:true 时先让已配置的 AI 把自然语言需求提炼成英文关键词(aiExtractGithubKeywords),
 * 提炼失败/未配置自动降级为需求英文词兜底,再不行整句直搜;一切失败降级空数组 + message 不抛。
 * fetchGithubMcpConfig:MCP 仓库的「下载」落地方式——MCP 是纯配置无实体,从仓库 README 的
 * mcpServers/servers(VS Code 风格)JSON 配置块里 best-effort 提取启动配置(command/args/env 或
 * url/headers),供 GUI 弹窗预填 / CLI mcp add --github / TUI Enter 直接写入注册表;
 * 提取不到(如 matlab-mcp-server 需手工下载 release 二进制)降级 spec:null + message 引导手动填。
 */
import { aiExtractGithubKeywords, fallbackGithubKeywords } from './ai.js';
import { McpError, readMcps } from './mcps.js';
import { searchGithubSkillsCached } from './recommend.js';
import { readRegistry } from './registry.js';

export interface CatalogCategory {
  id: string;
  name: string; // 显示名(CLI/TUI 用)
}

/** 分类统计:在分类定义上附加条数,供 GUI 标签页 / CLI 分类清单 / TUI 分类切换显示 */
export interface CatalogCategoryStat extends CatalogCategory {
  count: number;  // 该分类条目总数(skill + MCP)
  skills: number; // 其中 skill 仓库条数
  mcps: number;   // 其中 MCP server 条数
}

/** MCP 推荐条目的安装载荷:字段与 mcps.upsertMcp 对齐;env/headers 的值是占位符,用户需替换 */
export interface CatalogMcpSpec {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;               // stdio
  args?: string[];                // stdio
  env?: Record<string, string>;   // stdio
  url?: string;                   // http/sse
  headers?: Record<string, string>; // http/sse
}

export interface CatalogEntry {
  id: string;          // skill 条目:"owner/repo";MCP 条目:server 名(^[A-Za-z0-9_-]{1,64}$)
  name: string;
  description: string;
  stars: number;       // 收录时快照;无公开仓库的官方托管 MCP 记 0(前端不显示 ★)
  url: string;         // skill: https://github.com/<id>;MCP: 仓库或官方文档链接
  category: string;    // CATALOG_CATEGORIES 中的 id
  subdir?: string;     // skills 集中在仓库子目录时指明扫描根(合集仓库常见 "skills/")
  kind?: 'skill' | 'mcp'; // 缺省 skill(早期数据无此字段)
  mcp?: CatalogMcpSpec;   // kind === 'mcp' 时的安装载荷
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { id: 'dev', name: '软件开发' },
  { id: 'research', name: '科研' },
  { id: 'writing', name: '写作' },
  { id: 'marketing', name: '营销增长' },
  { id: 'product', name: '产品管理' },
  { id: 'design', name: '设计' },
  { id: 'media', name: '音视频与图像' },
  { id: 'knowledge', name: '知识管理' },
  { id: 'data-ai', name: '数据与 AI' },
  { id: 'robotics', name: '机器人开发' },
  { id: 'devops', name: 'DevOps 运维' },
  { id: 'security', name: '安全' },
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
  { id: 'vercel-labs/agent-skills', name: 'Vercel Agent Skills', description: 'Vercel 官方技能 9 个:React 最佳实践、组合模式、Web 设计规范', stars: 30604, url: 'https://github.com/vercel-labs/agent-skills', category: 'dev', subdir: 'skills' },
  { id: 'vercel-labs/skills', name: 'skills(Vercel)', description: 'Agent Skills 生态官方安装工具(npx skills);附 find-skills 技能', stars: 29880, url: 'https://github.com/vercel-labs/skills', category: 'dev', subdir: 'skills' },
  { id: 'tt-a1i/archify', name: 'Archify', description: '生成美观且可校验的架构图、工作流图、时序图、数据流图', stars: 26579, url: 'https://github.com/tt-a1i/archify', category: 'dev' },
  { id: 'Jeffallan/claude-skills', name: 'Full-Stack Skills', description: '全栈专家技能 67 个:多语言开发、架构设计、调试、文档与 DBA', stars: 11233, url: 'https://github.com/Jeffallan/claude-skills', category: 'dev', subdir: 'skills' },
  { id: 'antfu/skills', name: 'Anthony Fu Skills', description: 'Anthony Fu 前端生态技能 19 个:Vue/Vite/Nuxt/UnoCSS 最佳实践', stars: 5814, url: 'https://github.com/antfu/skills', category: 'dev', subdir: 'skills' },
  { id: 'DenisSergeevitch/agents-best-practices', name: 'Agents Best Practices', description: '厂商中立的 agent 与 harness 设计最佳实践(单技能)', stars: 2249, url: 'https://github.com/DenisSergeevitch/agents-best-practices', category: 'dev' },
  { id: 'affaan-m/ECC', name: 'ECC 技能合集', description: '高人气 agent 工作流系统自带技能集 39 个:API 设计、调试、研究、内容生产等', stars: 244104, url: 'https://github.com/affaan-m/ECC', category: 'dev', subdir: '.agents/skills' },
  { id: 'JuliusBrussee/caveman', name: 'Caveman', description: '极致省 token 的开发技能 20 个:上下文压缩、代码探索、评审、安全重构、迁移', stars: 101719, url: 'https://github.com/JuliusBrussee/caveman', category: 'dev', subdir: 'skills' },
  { id: 'JCodesMore/ai-website-cloner-template', name: 'AI Website Cloner', description: '一条命令用 AI 克隆任意网站(单技能)', stars: 33193, url: 'https://github.com/JCodesMore/ai-website-cloner-template', category: 'dev', subdir: '.claude/skills' },
  { id: 'yusufkaraaslan/Skill_Seekers', name: 'Skill Seekers', description: '把文档网站、GitHub 仓库、PDF 自动转换成可用 skill(单技能)', stars: 14856, url: 'https://github.com/yusufkaraaslan/Skill_Seekers', category: 'dev', subdir: 'skills' },
  { id: 'nidhinjs/prompt-master', name: 'Prompt Master', description: '为任意 AI 工具生成准确提示词(单技能)', stars: 11967, url: 'https://github.com/nidhinjs/prompt-master', category: 'dev' },
  { id: 'mxyhi/ok-skills', name: 'OK Skills', description: '策划的编码 agent 技能与 AGENTS.md 手册 36 个:浏览器、设计、研究等', stars: 479, url: 'https://github.com/mxyhi/ok-skills', category: 'dev' },
  { id: 'TerminalSkills/skills', name: 'TerminalSkills 超大合集', description: '1000+ 技能的超大合集:开发、运维、设计、办公全主题(单仓数量极大,按需选用)', stars: 140, url: 'https://github.com/TerminalSkills/skills', category: 'dev', subdir: 'skills' },
  { id: 'mattpocock/skills', name: 'Matt Pocock Skills', description: 'Matt Pocock(Total TypeScript)实战工程技能 18 个:TDD、代码评审、架构改进、需求转工单', stars: 240778, url: 'https://github.com/mattpocock/skills', category: 'dev', subdir: 'skills/engineering' },
  { id: 'openai/skills', name: 'OpenAI Skills(Codex)', description: 'OpenAI 官方 Codex 技能目录 39 个:云平台部署、Figma 联动、GitHub 修复、PDF 处理等', stars: 25270, url: 'https://github.com/openai/skills', category: 'dev', subdir: 'skills/.curated' },
  { id: 'muratcankoylan/Agent-Skills-for-Context-Engineering', name: 'Context Engineering', description: '上下文工程技能 17 个:上下文压缩/优化、记忆系统、多 agent 模式、效果评估', stars: 17864, url: 'https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering', category: 'dev', subdir: 'skills' },
  { id: 'greensock/gsap-skills', name: 'GSAP Skills', description: 'GSAP 官方网页动画技能 8 个:ScrollTrigger、React 集成、时间轴、性能优化', stars: 14516, url: 'https://github.com/greensock/gsap-skills', category: 'dev', subdir: 'skills' },
  { id: 'twostraws/SwiftUI-Agent-Skill', name: 'SwiftUI Pro', description: 'SwiftUI 专家技能,Paul Hudson(Hacking with Swift)出品(单技能)', stars: 4625, url: 'https://github.com/twostraws/SwiftUI-Agent-Skill', category: 'dev' },
  { id: 'WordPress/agent-skills', name: 'WordPress Skills', description: 'WordPress 官方技能 18 个:区块/主题/插件开发、性能、WP-CLI 运维', stars: 2075, url: 'https://github.com/WordPress/agent-skills', category: 'dev', subdir: 'skills' },
  { id: 'callstackincubator/agent-skills', name: 'React Native Skills', description: 'React Native 技能 8 个:最佳实践、版本升级、导航、brownfield 迁移(Callstack 出品)', stars: 1628, url: 'https://github.com/callstackincubator/agent-skills', category: 'dev', subdir: 'skills' },
  { id: 'Kotlin/kotlin-agent-skills', name: 'Kotlin Skills', description: 'JetBrains 官方 Kotlin 技能 6 个:Java 迁移、AGP9 升级、构建性能、JPA 映射', stars: 1022, url: 'https://github.com/Kotlin/kotlin-agent-skills', category: 'dev', subdir: 'skills' },

  // ---- 科研 ----
  { id: 'K-Dense-AI/scientific-agent-skills', name: 'Scientific Agent Skills', description: '把 AI agent 变成 AI 科学家:生物信息(biopython/单细胞)、天文(astropy)、文献检索、实验平台集成等 163 个技能', stars: 36229, url: 'https://github.com/K-Dense-AI/scientific-agent-skills', category: 'research', subdir: 'skills' },
  { id: 'wanshuiyin/Auto-claude-code-research-in-sleep', name: 'ARIS 自动科研', description: '睡眠中自动做 ML 科研:选题、实验、论文写作评审闭环,187 技能', stars: 15411, url: 'https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep', category: 'research', subdir: 'skills' },
  { id: 'brycewang-stanford/Auto-Empirical-Research-Skills', name: 'Auto Empirical Research', description: '斯坦福实证研究技能:全流水线旗舰条目(Python/R/Stata 版)与论文写作', stars: 3587, url: 'https://github.com/brycewang-stanford/Auto-Empirical-Research-Skills', category: 'research', subdir: 'skills' },
  { id: 'xuzhougeng/wisp-science', name: 'Wisp Science', description: '本地优先的 AI 科研工作台技能:文献证据审计、分析工作流等 34 个技能', stars: 1060, url: 'https://github.com/xuzhougeng/wisp-science', category: 'research', subdir: 'skills' },
  { id: 'mvanhorn/last30days-skill', name: 'Last 30 Days', description: '调研任意话题近 30 天的 Reddit/X/YouTube/HN 讨论舆情(单技能)', stars: 60118, url: 'https://github.com/mvanhorn/last30days-skill', category: 'research', subdir: 'skills' },
  { id: 'Imbad0202/academic-research-skills', name: 'Academic Research Skills', description: '学术研究闭环 4 技能:研究、写作、评审、修改', stars: 44158, url: 'https://github.com/Imbad0202/academic-research-skills', category: 'research' },
  { id: 'tigerless-labs/design-harness', name: 'Design Harness', description: '把论文与半成品想法链接成系统设计方案(单技能)', stars: 211, url: 'https://github.com/tigerless-labs/design-harness', category: 'research', subdir: 'plugins/design-harness/skills' },
  { id: 'O0000-code/paper-search-pro', name: 'Paper Search Pro', description: '学术文献发现与检索(单技能)', stars: 150, url: 'https://github.com/O0000-code/paper-search-pro', category: 'research' },
  { id: 'Yuan1z0825/nature-skills', name: 'Nature Skills', description: 'Nature 级学术表达与科研绘图 20 技能:文献检索、润色、统计、图表、综述', stars: 37793, url: 'https://github.com/Yuan1z0825/nature-skills', category: 'research', subdir: 'skills' },

  // ---- 写作 ----
  { id: 'blader/humanizer', name: 'Humanizer', description: '去除文本中的 AI 写作痕迹,让表达更自然(单技能)', stars: 38553, url: 'https://github.com/blader/humanizer', category: 'writing' },
  { id: 'JimLiu/baoyu-skills', name: '宝玉技能集', description: '宝玉的内容创作技能 21 个:翻译、配图、排版、发布到公众号/X', stars: 25452, url: 'https://github.com/JimLiu/baoyu-skills', category: 'writing', subdir: 'skills' },
  { id: 'zenstory-ai/oh-story-claudecode', name: '网文写作包', description: '网文/小说全流程 13 技能:扫榜、拆文、写作、去 AI 味、封面', stars: 6196, url: 'https://github.com/zenstory-ai/oh-story-claudecode', category: 'writing', subdir: 'skills' },
  { id: 'tizzy916/humanities-writing-companion', name: 'Humanities Writing', description: '人文学科写作全流程助手:选题、结构、引注、润色(单技能)', stars: 370, url: 'https://github.com/tizzy916/humanities-writing-companion', category: 'writing' },

  // ---- 营销增长 ----
  { id: 'coreyhaines31/marketingskills', name: 'Marketing Skills', description: '营销增长技能 50 个:CRO、文案、SEO、广告投放、数据分析、冷邮件、竞品分析等', stars: 45967, url: 'https://github.com/coreyhaines31/marketingskills', category: 'marketing', subdir: 'skills' },
  { id: 'AgriciDaniel/claude-ads', name: 'Claude Ads', description: '广告投放运营 33 技能:Google/Meta/Amazon 等 12 平台审计优化', stars: 8568, url: 'https://github.com/AgriciDaniel/claude-ads', category: 'marketing', subdir: 'skills' },
  { id: 'geekjourneyx/md2wechat-skill', name: 'MD2WeChat', description: 'Markdown 一键排版发布微信公众号:40+ 主题、AI 配图、多账号', stars: 3602, url: 'https://github.com/geekjourneyx/md2wechat-skill', category: 'marketing', subdir: 'skills' },
  { id: 'wondelai/skills', name: 'Wondel 商业框架合集', description: '商业/营销/UX/开发方法论框架 190+ 个:蓝海战略、增长黑客、DDD 等(量大,按需绑定)', stars: 2054, url: 'https://github.com/wondelai/skills', category: 'marketing' },

  // ---- 产品管理 ----
  { id: 'deanpeters/Product-Manager-Skills', name: 'PM Skills', description: '产品经理技能 77 个:用户访谈、竞品情报、路线图、增长矩阵', stars: 6719, url: 'https://github.com/deanpeters/Product-Manager-Skills', category: 'product', subdir: 'skills' },
  { id: 'nexscope-ai/eCommerce-Skills', name: 'E-commerce Skills', description: '电商运营技能 160+:选品调研、动态定价、Listing、广告投放', stars: 818, url: 'https://github.com/nexscope-ai/eCommerce-Skills', category: 'product' },
  { id: 'slavingia/skills', name: 'Minimalist Entrepreneur', description: 'Sahil Lavingia(Gumroad 创始人)《极简创业者》方法论 10 技能:MVP、定价、冷启动、首批用户', stars: 9938, url: 'https://github.com/slavingia/skills', category: 'product', subdir: 'skills' },

  // ---- 设计 ----
  { id: 'nexu-io/open-design', name: 'Open Design', description: '开源 AI 设计 Agent:114 套设计模板技能(PPT/海报/仪表盘/网页)', stars: 92521, url: 'https://github.com/nexu-io/open-design', category: 'design', subdir: 'design-templates' },
  { id: 'cathrynlavery/diagram-design', name: 'Diagram Design', description: '38 种编辑级图表类型,自包含 HTML+SVG 输出,零依赖', stars: 28273, url: 'https://github.com/cathrynlavery/diagram-design', category: 'design', subdir: 'skills' },
  { id: 'ibelick/ui-skills', name: 'UI Skills', description: '设计工程师技能 7 个:UI 去 AI 味、设计规范、可访问性修复', stars: 7763, url: 'https://github.com/ibelick/ui-skills', category: 'design', subdir: 'skills' },
  { id: 'JimLiu/baoyu-design', name: 'Baoyu Design', description: '宝玉的 Claude Design 本地化技能:生成精致设计稿', stars: 3628, url: 'https://github.com/JimLiu/baoyu-design', category: 'design', subdir: 'skills' },
  { id: 'bergside/typeui', name: 'TypeUI', description: '用 AI 构建更好的 UI:设计基础技能', stars: 1836, url: 'https://github.com/bergside/typeui', category: 'design', subdir: 'skills' },
  { id: 'zanwei/design-dna', name: 'Design DNA', description: '从参考 UI(截图/图片/URL)提取量化设计 DNA:tokens、配色、排版(单技能)', stars: 1555, url: 'https://github.com/zanwei/design-dna', category: 'design' },
  { id: 'LottieFiles/motion-design-skill', name: 'Motion Design', description: 'LottieFiles 出品动效设计原则:时序、缓动、编舞与迪士尼十二原则', stars: 1432, url: 'https://github.com/LottieFiles/motion-design-skill', category: 'design', subdir: 'skills' },
  { id: 'nateherkai/scroll-craft', name: 'Scroll Craft', description: '高端滚动叙事网站:滚动即时间轴的视觉叙事技能', stars: 1144, url: 'https://github.com/nateherkai/scroll-craft', category: 'design', subdir: 'plugins' },
  { id: 'nextlevelbuilder/ui-ux-pro-max-skill', name: 'UI/UX Pro Max', description: '专业 UI/UX 设计智能 7 技能:品牌、设计系统、幻灯片、UI 风格规范', stars: 122825, url: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill', category: 'design', subdir: '.claude/skills' },
  { id: 'nexu-io/html-anything', name: 'HTML Anything', description: '智能体 HTML 编辑器内置模板技能约 80 个:文章、幻灯片、仪表盘、社交卡片', stars: 8546, url: 'https://github.com/nexu-io/html-anything', category: 'design', subdir: 'next/src/lib/templates/skills' },
  { id: 'Railly/tinte', name: 'Tinte', description: '从参考提取设计系统,编译成 agent 可用的主题技能(2 个技能)', stars: 615, url: 'https://github.com/Railly/tinte', category: 'design', subdir: 'skills' },
  { id: 'emilkowalski/skills', name: 'Emil Kowalski Skills', description: 'Emil Kowalski 设计工程技能 12 个:动画原则、Apple 设计、UI 库选型、原型', stars: 33374, url: 'https://github.com/emilkowalski/skills', category: 'design', subdir: 'skills' },
  { id: 'ConardLi/garden-skills', name: 'Garden Skills', description: 'ConardLi 精选技能 5 个:网页设计工程师、图文美化、知识检索、视频演示', stars: 11631, url: 'https://github.com/ConardLi/garden-skills', category: 'design', subdir: 'skills' },
  { id: 'Agents365-ai/drawio-skill', name: 'Drawio Skill', description: '自然语言生成 drawio 图表:UML、流程图等 11 种预设(单技能)', stars: 8312, url: 'https://github.com/Agents365-ai/drawio-skill', category: 'design', subdir: 'skills' },

  // ---- 音视频与图像 ----
  { id: 'Vincentwei1021/video-shotcraft', name: 'Video Shotcraft', description: '用 Remotion 把网页做成电影感产品视频:镜头卡、运镜、卡点', stars: 6636, url: 'https://github.com/Vincentwei1021/video-shotcraft', category: 'media' },
  { id: 'digitalsamba/claude-code-video-toolkit', name: 'Video Toolkit', description: 'AI 视频生产 12 技能:FFmpeg、Remotion、ElevenLabs 配音等', stars: 2021, url: 'https://github.com/digitalsamba/claude-code-video-toolkit', category: 'media', subdir: '.claude/skills' },
  { id: 'calesthio/OpenMontage', name: 'OpenMontage', description: '开源智能体视频生产系统:视频生成、配音、动效、图像等数十个技能', stars: 53826, url: 'https://github.com/calesthio/OpenMontage', category: 'media', subdir: '.agents/skills' },
  { id: 'gnipbao/story-to-handdrawn-video', name: 'Story to Handdrawn Video', description: '中文故事文案/图片一键转手绘风视频(单技能)', stars: 1713, url: 'https://github.com/gnipbao/story-to-handdrawn-video', category: 'media', subdir: 'skill-package' },
  { id: 'zenstory-ai/drama-skills', name: '短剧创作包', description: 'AI 短剧/漫剧创作 10 技能:剧本、资产、分镜、图/视频提示词、审查', stars: 1355, url: 'https://github.com/zenstory-ai/drama-skills', category: 'media', subdir: 'skills' },
  { id: 'pexoai/pexo-skills', name: 'Pexo Skills', description: 'AI 视频生成技能 20 个:产品视频、TikTok 广告、Veo/Seedance 提示词', stars: 776, url: 'https://github.com/pexoai/pexo-skills', category: 'media', subdir: 'skills' },
  { id: 'Yusuke710/manim-skill', name: 'Manim Skill', description: '用 Manim 自动生成数学/科普动画:agent 自主规划场景与脚本(单技能)', stars: 145, url: 'https://github.com/Yusuke710/manim-skill', category: 'media', subdir: 'skills' },

  // ---- 知识管理 ----
  { id: 'kepano/obsidian-skills', name: 'Obsidian Skills(官方)', description: 'Obsidian 创始人出品的官方技能 5 个:Obsidian CLI、Bases、Canvas、Markdown', stars: 47493, url: 'https://github.com/kepano/obsidian-skills', category: 'knowledge', subdir: 'skills' },
  { id: 'virgiliojr94/book-to-skill', name: 'Book to Skill', description: '把任意技术书 PDF 变成可学习、可引用的 skill(单技能)', stars: 26599, url: 'https://github.com/virgiliojr94/book-to-skill', category: 'knowledge' },
  { id: 'titanwings/distilly', name: 'Distilly', description: '把同事/专家的思维方式蒸馏成可复用 AI Skill,持续进化(单技能)', stars: 24119, url: 'https://github.com/titanwings/distilly', category: 'knowledge' },
  { id: 'teng-lin/notebooklm-py', name: 'NotebookLM', description: 'NotebookLM 全功能操控:建笔记本、加资料、生成播客(单技能)', stars: 18993, url: 'https://github.com/teng-lin/notebooklm-py', category: 'knowledge' },
  { id: 'AgriciDaniel/claude-obsidian', name: 'Claude Obsidian', description: 'Obsidian 第二大脑 15 技能:自动研究、wiki 整理、检索入库', stars: 14328, url: 'https://github.com/AgriciDaniel/claude-obsidian', category: 'knowledge', subdir: 'skills' },
  { id: 'huytieu/COG-second-brain', name: 'COG Second Brain', description: '自进化第二大脑:日记、日报、自动研究、内容工厂等 33 个技能闭环', stars: 1138, url: 'https://github.com/huytieu/COG-second-brain', category: 'knowledge', subdir: 'skills' },
  { id: 'chubbyguan/chubbyskills', name: '胖馆长技能集', description: '中文全渠道内容采集进个人知识库 13 技能:抖音/B站/小红书/公众号/播客', stars: 651, url: 'https://github.com/chubbyguan/chubbyskills', category: 'knowledge' },

  // ---- 数据与 AI ----
  { id: 'browser-act/skills', name: 'Browser Act', description: 'Agent 浏览器自动化 CLI 技能:渲染抓取、表单填写、会话保持', stars: 5517, url: 'https://github.com/browser-act/skills', category: 'data-ai' },
  { id: 'timescale/pg-aiguide', name: 'Postgres AI Guide', description: 'Timescale 官方 Postgres 技能 10 个:表设计、迁移、pgvector', stars: 1825, url: 'https://github.com/timescale/pg-aiguide', category: 'data-ai', subdir: 'skills' },
  { id: 'Kaelio/ktx', name: 'ktx', description: '数据与分析 agent 的可执行上下文层(Claude Code/Codex 等通用)', stars: 1564, url: 'https://github.com/Kaelio/ktx', category: 'data-ai', subdir: 'skills' },
  { id: 'NevaMind-AI/memU', name: 'memU', description: '跨 agent 的个人持久记忆:记住偏好与事实(单技能)', stars: 14357, url: 'https://github.com/NevaMind-AI/memU', category: 'data-ai' },
  { id: 'machina-sports/sports-skills', name: 'Sports Skills', description: '体育数据与预测市场技能 26 个:NBA/NFL/F1 数据、Polymarket 等', stars: 209, url: 'https://github.com/machina-sports/sports-skills', category: 'data-ai', subdir: 'skills' },
  { id: 'huggingface/skills', name: 'Hugging Face Skills', description: 'Hugging Face 官方技能 25 个:模型训练(TRL/LoRA)、数据集、Spaces、论文发布', stars: 10984, url: 'https://github.com/huggingface/skills', category: 'data-ai', subdir: 'skills' },
  { id: 'MiniMax-AI/skills', name: 'MiniMax Skills', description: 'MiniMax 官方技能 17 个:多模态生成(音乐/贴纸)、文档处理(docx/pdf/xlsx)、移动/前端开发', stars: 13471, url: 'https://github.com/MiniMax-AI/skills', category: 'data-ai', subdir: 'skills' },
  { id: 'apify/agent-skills', name: 'Apify Skills', description: 'Apify 官方网页抓取技能 5 个:Actor 开发、SDK 集成、输出 schema、终极抓取', stars: 2362, url: 'https://github.com/apify/agent-skills', category: 'data-ai', subdir: 'skills' },
  { id: 'supabase/agent-skills', name: 'Supabase Skills', description: 'Supabase 官方技能:Postgres 最佳实践、Supabase 使用指导(2 个技能)', stars: 2561, url: 'https://github.com/supabase/agent-skills', category: 'data-ai', subdir: 'skills' },

  // ---- 机器人开发 ----
  { id: 'arpitg1304/robotics-agent-skills', name: 'Robotics Agent Skills', description: '机器人软件开发 10 技能:ROS 2、感知、测试、安全、设计模式', stars: 348, url: 'https://github.com/arpitg1304/robotics-agent-skills', category: 'robotics', subdir: 'skills' },
  { id: 'dbwls99706/ros2-engineering-skills', name: 'ROS 2 Engineering', description: '生产级 ROS 2 工程实践(单技能)', stars: 158, url: 'https://github.com/dbwls99706/ros2-engineering-skills', category: 'robotics' },

  // ---- DevOps 运维 ----
  { id: 'google/skills', name: 'Google Cloud Skills', description: 'Google 官方云技能 110 个:BigQuery、Vertex AI、Cloud Run 等', stars: 18942, url: 'https://github.com/google/skills', category: 'devops', subdir: 'skills/cloud' },
  { id: 'kubesphere/kubesphere', name: 'KubeSphere', description: 'K8s 多云容器平台官方技能集 32 个:集群、应用、可观测性运维', stars: 17032, url: 'https://github.com/kubesphere/kubesphere', category: 'devops', subdir: 'skills' },
  { id: 'glitternetwork/pinme', name: 'Pinme', description: '一条命令部署前端/全栈应用到 IPFS:上传、存储、发布 7 技能', stars: 3751, url: 'https://github.com/glitternetwork/pinme', category: 'devops', subdir: 'skills' },
  { id: 'antonbabenko/terraform-skill', name: 'Terraform Skill', description: 'Terraform/OpenTofu 技能:测试、模块、CI/CD 与生产模式(antonbabenko 出品)', stars: 2309, url: 'https://github.com/antonbabenko/terraform-skill', category: 'devops', subdir: 'skills' },
  { id: 'hashicorp/agent-skills', name: 'HashiCorp Skills', description: 'HashiCorp 官方 Terraform 技能 16 个:Provider 开发、Stacks', stars: 852, url: 'https://github.com/hashicorp/agent-skills', category: 'devops', subdir: 'plugins/terraform/skills' },
  { id: 'itsmostafa/aws-agent-skills', name: 'AWS Agent Skills', description: 'AWS 服务技能 18 个:EC2/S3/Lambda/EKS/CloudFormation/IAM 等核心服务', stars: 1150, url: 'https://github.com/itsmostafa/aws-agent-skills', category: 'devops', subdir: 'skills' },

  // ---- 安全 ----
  { id: 'elementalsouls/Claude-BugHunter', name: 'Claude BugHunter', description: '漏洞赏金与红队 83 技能:侦察、Web 漏洞、云配置、AI 安全测试', stars: 3834, url: 'https://github.com/elementalsouls/Claude-BugHunter', category: 'security', subdir: 'skills' },
  { id: 'ljagiello/ctf-skills', name: 'CTF Skills', description: 'CTF 解题技能 11 个:Web 利用、Pwn、逆向、密码、取证、OSINT', stars: 3132, url: 'https://github.com/ljagiello/ctf-skills', category: 'security' },
  { id: 'mukul975/Anthropic-Cybersecurity-Skills', name: 'Cybersecurity Skills 合集', description: '结构化网络安全技能 800+:漏洞分析、数字取证、威胁狩猎、云安全(量大,按需绑定)', stars: 31590, url: 'https://github.com/mukul975/Anthropic-Cybersecurity-Skills', category: 'security', subdir: 'skills' },

  // ---- 效率办公 ----
  { id: 'googleworkspace/cli', name: 'Google Workspace CLI', description: 'Google Workspace 自动化技能 95 个:Drive/Gmail/日历/文档/表格/Chat/Classroom', stars: 30617, url: 'https://github.com/googleworkspace/cli', category: 'productivity', subdir: 'skills' },
  { id: 'OthmanAdi/planning-with-files', name: 'Planning with Files', description: '文件式持久规划:计划落盘,长任务上下文丢失也能无缝续作', stars: 26404, url: 'https://github.com/OthmanAdi/planning-with-files', category: 'productivity', subdir: 'skills' },
  { id: 'ayghri/i-have-adhd', name: 'I Have ADHD', description: 'ADHD 友好输出模式:结论先行、步骤编号、进度可见(单技能)', stars: 25467, url: 'https://github.com/ayghri/i-have-adhd', category: 'productivity', subdir: 'skills' },
  { id: 'KKKKhazix/khazix-skills', name: '卡兹克技能集', description: '数字生命卡兹克开源合集 6 技能:leader 目标定义、neat-freak 整理、热点追踪等', stars: 20243, url: 'https://github.com/KKKKhazix/khazix-skills', category: 'productivity' },

  // ---- MCP 服务(常用软件;安装即写入中央注册表,密钥占位符需自行替换)----
  // 软件开发
  { id: 'playwright', kind: 'mcp', name: 'Playwright', description: '微软官方浏览器自动化:页面操作、截图、E2E 测试', stars: 36598, url: 'https://github.com/microsoft/playwright-mcp', category: 'dev', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  { id: 'chrome-devtools', kind: 'mcp', name: 'Chrome DevTools', description: 'Google 官方:Chrome 调试、性能/网络分析、控制台检查', stars: 50080, url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp', category: 'dev', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] } },
  { id: 'context7', kind: 'mcp', name: 'Context7', description: '把最新版库文档拉进对话:查 API 用法不再凭训练记忆', stars: 61379, url: 'https://github.com/upstash/context7', category: 'dev', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] } },
  { id: 'github', kind: 'mcp', name: 'GitHub 官方', description: 'GitHub 官方托管:issue/PR/仓库/Actions 操作(headers 里的 token 是占位符,需替换)', stars: 32592, url: 'https://github.com/github/github-mcp-server', category: 'dev', mcp: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer YOUR_GITHUB_TOKEN' } } },
  { id: 'magic', kind: 'mcp', name: '21st.dev Magic', description: '像 v0 一样用自然语言生成 UI 组件(env 里的 key 是占位符,需替换)', stars: 5752, url: 'https://github.com/21st-dev/magic-mcp', category: 'dev', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@21st-dev/magic@latest'], env: { TWENTY_FIRST_API_KEY: 'YOUR_21ST_API_KEY' } } },
  { id: 'deepwiki', kind: 'mcp', name: 'DeepWiki', description: 'Cognition 官方托管:任意 GitHub 仓库的文档问答,免费免登录', stars: 0, url: 'https://mcp.deepwiki.com/mcp', category: 'dev', mcp: { transport: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
  // 效率办公
  { id: 'filesystem', kind: 'mcp', name: 'Filesystem', description: '官方本地文件系统读写;参数里的 "." 表示向 agent 启动目录开放,可在 MCP 页改', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'productivity', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
  { id: 'sequential-thinking', kind: 'mcp', name: 'Sequential Thinking', description: '官方分步思考:把复杂任务拆成可修订、可分支的思考序列', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'productivity', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } },
  { id: 'slack', kind: 'mcp', name: 'Slack', description: '官方存档版 Slack:频道读写、消息搜索(env 里的 token/team id 是占位符,需替换)', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'productivity', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: 'YOUR_SLACK_BOT_TOKEN', SLACK_TEAM_ID: 'YOUR_SLACK_TEAM_ID' } } },
  { id: 'atlassian', kind: 'mcp', name: 'Atlassian', description: 'Jira/Confluence 官方托管,首次连接走 OAuth 登录', stars: 0, url: 'https://mcp.atlassian.com/v1/sse', category: 'productivity', mcp: { transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } },
  // 数据与 AI
  { id: 'memory', kind: 'mcp', name: 'Memory', description: '官方持久记忆:跨会话维护知识图谱,记住偏好与事实', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'data-ai', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
  { id: 'postgres', kind: 'mcp', name: 'PostgreSQL', description: 'Postgres 只读查询(官方存档版);连接串是占位符,需替换成你的库', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'data-ai', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost:5432/postgres'] } },
  { id: 'mongodb', kind: 'mcp', name: 'MongoDB 官方', description: 'MongoDB 官方:默认只读模式连接库与 Atlas;连接串是占位符,需替换', stars: 1113, url: 'https://github.com/mongodb-js/mongodb-mcp-server', category: 'data-ai', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'mongodb-mcp-server', '--readOnly'], env: { MDB_MCP_CONNECTION_STRING: 'mongodb://localhost:27017/myDatabase' } } },
  { id: 'neon', kind: 'mcp', name: 'Neon', description: 'Neon 官方托管:Serverless Postgres 项目与分支管理,首次连接走 OAuth 登录', stars: 624, url: 'https://github.com/neondatabase/mcp-server-neon', category: 'data-ai', mcp: { transport: 'http', url: 'https://mcp.neon.tech/mcp' } },
  { id: 'huggingface', kind: 'mcp', name: 'Hugging Face', description: 'Hugging Face 官方托管:模型/数据集/Space 检索与调用', stars: 0, url: 'https://huggingface.co/mcp', category: 'data-ai', mcp: { transport: 'http', url: 'https://huggingface.co/mcp' } },
  // 产品管理
  { id: 'notion', kind: 'mcp', name: 'Notion', description: 'Notion 官方托管:页面/数据库读写,首次连接走 OAuth 登录', stars: 4612, url: 'https://github.com/makenotion/notion-mcp-server', category: 'product', mcp: { transport: 'http', url: 'https://mcp.notion.com/mcp' } },
  { id: 'linear', kind: 'mcp', name: 'Linear', description: 'Linear 官方托管:issue 与项目管理,首次连接走 OAuth 登录', stars: 0, url: 'https://linear.app/docs/mcp', category: 'product', mcp: { transport: 'http', url: 'https://mcp.linear.app/mcp' } },
  // 设计
  { id: 'figma', kind: 'mcp', name: 'Figma(Framelink)', description: '把 Figma 设计稿变成结构化上下文(社区最流行实现);--figma-api-key 是占位符,需替换', stars: 15733, url: 'https://github.com/GLips/Figma-Context-MCP', category: 'design', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--figma-api-key=YOUR_FIGMA_TOKEN', '--stdio'] } },
  // 安全
  { id: 'semgrep', kind: 'mcp', name: 'Semgrep', description: 'Semgrep 官方托管:代码安全漏洞与 SAST 扫描', stars: 684, url: 'https://github.com/semgrep/mcp', category: 'security', mcp: { transport: 'http', url: 'https://mcp.semgrep.ai/mcp' } },
  // 音视频与图像
  { id: 'everart', kind: 'mcp', name: 'EverArt', description: '官方 EverArt 图像生成:多模型出图(env 里的 key 是占位符,需替换)', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'media', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everart'], env: { EVERART_API_KEY: 'YOUR_EVERART_KEY' } } },
  // 科研
  { id: 'brave-search', kind: 'mcp', name: 'Brave Search', description: 'Brave 搜索 API:网页检索,免费额度每月 2000 次(env 里的 key 是占位符,需替换)', stars: 89948, url: 'https://github.com/modelcontextprotocol/servers', category: 'research', mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: 'YOUR_BRAVE_KEY' } } },
  { id: 'tavily', kind: 'mcp', name: 'Tavily', description: '为 agent 设计的实时搜索/抓取 API(env 里的 key 是占位符,需替换)', stars: 2361, url: 'https://github.com/tavily-ai/tavily-mcp', category: 'research', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'tavily-mcp@latest'], env: { TAVILY_API_KEY: 'YOUR_TAVILY_KEY' } } },
  { id: 'exa', kind: 'mcp', name: 'Exa', description: 'Exa 官方托管:面向 AI 的网页搜索与抓取', stars: 4942, url: 'https://github.com/exa-labs/exa-mcp-server', category: 'research', mcp: { transport: 'http', url: 'https://mcp.exa.ai/mcp' } },
  // DevOps 运维
  { id: 'sentry', kind: 'mcp', name: 'Sentry', description: 'Sentry 官方托管:错误监控、issue 分析与修复建议,首次连接走 OAuth 登录', stars: 0, url: 'https://mcp.sentry.dev/mcp', category: 'devops', mcp: { transport: 'http', url: 'https://mcp.sentry.dev/mcp' } },
  { id: 'kubernetes', kind: 'mcp', name: 'Kubernetes', description: '读取本机 kubeconfig 管理 K8s 集群:资源查看、运维操作', stars: 1576, url: 'https://github.com/Flux159/mcp-server-kubernetes', category: 'devops', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'mcp-server-kubernetes@latest'] } },
];

export interface CatalogFilter {
  category?: string;
  query?: string;
  /** 按条目类型过滤:skill 仓库 / MCP server;缺省返回两类混排(向后兼容) */
  kind?: 'skill' | 'mcp';
}

/** 条目类型:早期数据无 kind 字段,缺省视为 skill */
export function catalogEntryKind(e: CatalogEntry): 'skill' | 'mcp' {
  return e.kind === 'mcp' ? 'mcp' : 'skill';
}

/** 过滤 + 排序:默认按 stars 降序;query 大小写不敏感匹配 name/description/id;kind 把 skills 与 MCP 分流 */
export function listCatalog(filter: CatalogFilter = {}): CatalogEntry[] {
  let items = [...CATALOG].sort((a, b) => b.stars - a.stars);
  if (filter.kind) items = items.filter((e) => catalogEntryKind(e) === filter.kind);
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

/**
 * 分类统计:每个分类的条目数(细分 skill / MCP),顺序与 CATALOG_CATEGORIES 一致。
 * 静态数据内存计算,无 IO;GUI 标签页角标、`ssw catalog categories`、TUI 分类切换共用。
 */
export function listCatalogCategories(): CatalogCategoryStat[] {
  return CATALOG_CATEGORIES.map((c) => {
    const entries = CATALOG.filter((e) => e.category === c.id);
    return {
      ...c,
      count: entries.length,
      skills: entries.filter((e) => e.kind !== 'mcp').length,
      mcps: entries.filter((e) => e.kind === 'mcp').length,
    };
  });
}

export interface CatalogEntryWithInstalled extends CatalogEntry {
  installed: boolean;
  installedCount: number; // skill:库中该仓库的条目数(一仓多 skill);MCP:已注册为 1,否则 0
}

/**
 * 附加安装标记:
 * - skill 条目:registry 中 id 以 "<owner/repo>:" 开头即视为已安装(大小写不敏感);
 * - MCP 条目:中央注册表(mcps.json)中已有同名 server 即视为已添加。
 */
export async function listCatalogWithInstalled(filter: CatalogFilter = {}): Promise<CatalogEntryWithInstalled[]> {
  const registry = await readRegistry();
  const mcpNames = new Set((await readMcps()).map((m) => m.name));
  return listCatalog(filter).map((e) => {
    if (e.kind === 'mcp') {
      const installed = mcpNames.has(e.id);
      return { ...e, installed, installedCount: installed ? 1 : 0 };
    }
    const prefix = `${e.id.toLowerCase()}:`;
    const count = registry.filter((s) => s.id.toLowerCase().startsWith(prefix)).length;
    return { ...e, installed: count > 0, installedCount: count };
  });
}

/** GitHub 联网搜索结果条目(推荐库「GitHub 搜索」;链接直达仓库,可一键安装/添加) */
export interface CatalogGithubItem {
  repo: string;        // owner/repo
  name: string;
  url: string;
  stars: number;
  description: string;
  keyword: string;     // 命中的搜索关键词(AI 提炼或需求兜底)
  installed: boolean;  // skill:库中已有该仓库条目;mcp:mcps.json 已有同名(建议名)server。只标记不排除
  installedCount: number;
  kind: 'skill' | 'mcp'; // 决定前端动作:skill「安装」整仓克隆;mcp「添加」写注册表(配置从 README 提取)
}

export interface CatalogGithubSearchResult {
  items: CatalogGithubItem[];
  keywords: string[]; // 实际使用的搜索词(提炼失败时可能是兜底词或需求整句;mcp 模式下裸 "mcp" 词不参与检索)
  ai: boolean;        // 关键词是否确实由 AI 提炼(false = 直连或兜底)
  kind: 'skill' | 'mcp'; // 本次搜索的仓库类型(显式指定或按搜索词自动判定)
  model?: string;
  message?: string;   // 降级说明(未配置 AI/限流/断网/无结果等)
}

/** 单次联网搜索返回的仓库上限 */
export const MAX_CATALOG_GITHUB_RESULTS = 12;

export interface CatalogGithubSearchOptions {
  /** true = 先用已配置的 AI 把自然语言需求提炼成英文关键词再搜(失败自动降级) */
  ai?: boolean;
  /** 搜哪类仓库:skill = topic:agent-skills(旧口径);mcp = topic:mcp-server / topic:model-context-protocol。
   *  缺省自动判定:搜索词/需求里含独立单词 "mcp"(如 "matlab mcp")时按 mcp 搜,否则按 skill 搜 */
  kind?: 'skill' | 'mcp';
  /** 测试注入;缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 推荐库联网搜索(24h 缓存复用 recommend.ts),多关键词结果合并去重(full_name 小写)、
 * 按 star 降序、上限 MAX_CATALOG_GITHUB_RESULTS。已入库的仓库只标 installed 不排除(用户可能想更新/重装);
 * 一切失败降级空数组 + message,不抛异常。
 * kind=mcp 时改搜 MCP 生态 topic(mcp-server / model-context-protocol,一词两查合并),
 * 裸 "mcp"/"server" 关键词不参与检索(不带信息量,还会让 top MCP 仓淹没结果)。
 */
export async function searchCatalogGithub(
  query: string,
  options: CatalogGithubSearchOptions = {},
): Promise<CatalogGithubSearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const q = query.trim();
  // 搜索哪类仓库:显式 kind 优先;否则搜索词含独立单词 "mcp"("matlab mcp" 这种)自动按 MCP server 搜
  const kind: 'skill' | 'mcp' = options.kind ?? (/(^|[^a-z0-9])mcp([^a-z0-9]|$)/i.test(q) ? 'mcp' : 'skill');
  if (!q) return { items: [], keywords: [], ai: false, kind, message: '请输入搜索词或需求描述' };

  // ---- 搜索词:ai 模式先让模型提炼;失败/未配置降级为需求英文词兜底,再不行整句直搜 ----
  let keywords: string[] = [];
  let ai = false;
  let model: string | undefined;
  let message: string | undefined;
  if (options.ai) {
    const r = await aiExtractGithubKeywords(q, fetchImpl);
    model = r.model;
    if (r.keywords.length) {
      keywords = r.keywords;
      ai = true;
    }
    message = r.message; // 提炼失败的说明(AI 不可用不代表不能搜,直连兜底继续)
  }
  if (!keywords.length) keywords = fallbackGithubKeywords(q);
  if (!keywords.length) keywords = [q.slice(0, 40)]; // 纯中文需求:整句交给 GitHub 搜索

  // 每个关键词展开成实际查询(mcp 模式一词两 topic);kw 记录到结果条目上标示命中来源。
  // keywords 的展示值保留原词(含 "mcp"),免得和用户输入对不上;检索词才做过滤
  const plan: { query: string; kw: string }[] = [];
  if (kind === 'mcp') {
    const kws = keywords.filter((k) => !/^(mcp[-_ ]?server|mcp|server)s?$/i.test(k.trim()));
    for (const kw of kws.length ? kws : ['']) {
      plan.push({ query: `topic:mcp-server ${kw}`.trim(), kw: kw || q.slice(0, 40) });
      plan.push({ query: `topic:model-context-protocol ${kw}`.trim(), kw: kw || q.slice(0, 40) });
    }
  } else {
    for (const kw of keywords) plan.push({ query: `topic:agent-skills ${kw}`, kw });
  }

  try {
    const perQuery = await Promise.all(plan.map((p) => searchGithubSkillsCached(p.query, fetchImpl)));
    // installed 口径:skill 按注册表 id 前缀("<owner/repo>:");mcp 按建议 server 名是否已在 mcps.json
    const registry = kind === 'skill' ? await readRegistry() : null;
    const mcpNames = kind === 'mcp' ? new Set((await readMcps()).map((m) => m.name.toLowerCase())) : null;
    const seen = new Set<string>();
    const items: CatalogGithubItem[] = [];
    for (let i = 0; i < plan.length; i++) {
      for (const r of perQuery[i]) {
        const key = r.full_name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        let installed = false;
        let installedCount = 0;
        if (kind === 'mcp') {
          installed = mcpNames!.has(suggestMcpName(r.name).toLowerCase());
          installedCount = installed ? 1 : 0;
        } else {
          const prefix = `${key}:`;
          installedCount = registry!.filter((s) => s.id.toLowerCase().startsWith(prefix)).length;
          installed = installedCount > 0;
        }
        items.push({
          repo: r.full_name,
          name: r.name,
          url: r.html_url,
          stars: r.stargazers_count,
          description: r.description ?? '',
          keyword: plan[i].kw,
          installed,
          installedCount,
          kind,
        });
      }
    }
    items.sort((a, b) => b.stars - a.stars);
    const sliced = items.slice(0, MAX_CATALOG_GITHUB_RESULTS);
    if (!sliced.length && !message) {
      message = kind === 'mcp'
        ? 'GitHub 上没有找到匹配的 MCP server 仓库(换个关键词试试)'
        : 'GitHub 上没有找到匹配的 agent-skills 仓库(换个关键词试试)';
    }
    return { items: sliced, keywords, ai, kind, model, message };
  } catch (err) {
    return {
      items: [],
      keywords,
      ai,
      kind,
      model,
      message: `GitHub 搜索不可用(已降级): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 由仓库名建议一个合法 MCP server 名:非法字符转 -、收敛连续 -、去首尾 -、截 64;兜底 'mcp-server' */
export function suggestMcpName(repoName: string): string {
  const cleaned = repoName
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'mcp-server';
}

/** fetchGithubMcpConfig 的结果:spec 为 null 表示没提取到(原因在 message),调用方引导手动填写 */
export interface GithubMcpConfigResult {
  repo: string;               // 规范化后的 owner/repo
  name: string;               // 建议的 server 名(仓库名经 suggestMcpName 清洗)
  spec: CatalogMcpSpec | null;
  message?: string;
}

/** 仓库输入白名单:owner/repo 或完整 GitHub URL(与 normalizeGithubUri 同口径,防止注入奇怪路径) */
const GITHUB_REPO_INPUT_RE = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/**
 * 从 GitHub 仓库 README 提取 MCP server 启动配置(best-effort):
 * 经 GitHub API 拿默认分支 README(base64),扫其中的 ```json 围栏块,找含 mcpServers(Claude 风格)
 * 或 servers(VS Code 风格)键的对象,取与仓库名相近的第一个 server 条目转成 CatalogMcpSpec。
 * 仓库非法抛 McpError(→400);网络/解析失败一律降级 { spec: null, message },不抛异常——
 * 很多 MCP 仓库(如 matlab-mcp-server,需手工下载 release 二进制)本就没有可直接套用的配置。
 */
export async function fetchGithubMcpConfig(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubMcpConfigResult> {
  const m = GITHUB_REPO_INPUT_RE.exec(repo.trim());
  if (!m) throw new McpError(`GitHub 仓库格式非法: ${repo}(应为 owner/repo 或完整 GitHub URL)`);
  const fullName = `${m[1]}/${m[2]}`;
  const name = suggestMcpName(m[2]);
  let readme: string;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}/readme`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'skills-switchtool' },
    });
    if (!res.ok) {
      return { repo: fullName, name, spec: null, message: `README 获取失败(GitHub API 返回 ${res.status}),请参照仓库说明手动填写` };
    }
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (data.encoding !== 'base64' || !data.content) {
      return { repo: fullName, name, spec: null, message: 'README 内容不可读,请参照仓库说明手动填写' };
    }
    // GitHub 的 base64 内容带换行,先去掉空白再解码
    readme = Buffer.from(data.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch (err) {
    return { repo: fullName, name, spec: null, message: `网络不可用(已降级): ${err instanceof Error ? err.message : String(err)}` };
  }
  const spec = extractMcpSpecFromReadme(readme, name);
  if (!spec) {
    return { repo: fullName, name, spec: null, message: 'README 中未找到 mcpServers 配置块,请参照仓库说明手动填写' };
  }
  return { repo: fullName, name, spec };
}

/** 从 README markdown 里提取第一个可用的 MCP server 配置;提取不到返回 null(纯函数,便于测试) */
function extractMcpSpecFromReadme(md: string, preferName: string): CatalogMcpSpec | null {
  const fenceRe = /```([a-zA-Z]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(md))) {
    const lang = match[1].toLowerCase();
    if (lang && lang !== 'json' && lang !== 'jsonc') continue; // 只看 json 围栏与未标注的块
    const body = match[2].trim();
    if (!body.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(body); // jsonc 注释/尾逗号解析失败就跳过该块,不做脆弱的正则清洗
    } catch {
      continue;
    }
    const spec = specFromServersObject(obj, preferName);
    if (spec) return spec;
  }
  return null;
}

/** 从解析出的 JSON 对象里取 mcpServers/servers 映射,挑一个 server 条目转 CatalogMcpSpec */
function specFromServersObject(obj: unknown, preferName: string): CatalogMcpSpec | null {
  if (!obj || typeof obj !== 'object') return null;
  const root = obj as Record<string, unknown>;
  const servers = (root.mcpServers ?? root.servers) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return null;
  const keys = Object.keys(servers);
  if (!keys.length) return null;
  // 多个 server 时优先名字与仓库名相近的(互含,大小写不敏感),否则取第一个
  const prefer = preferName.toLowerCase();
  const key = keys.find((k) => {
    const kl = k.toLowerCase();
    return prefer.includes(kl) || kl.includes(prefer);
  }) ?? keys[0];
  return normalizeMcpServerJson(servers[key]);
}

/** 单条 server JSON → CatalogMcpSpec:有 command 即 stdio;有 url/serverUrl 即远端(type/transport=sse 时按 sse) */
function normalizeMcpServerJson(entry: unknown): CatalogMcpSpec | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  // env/headers 只保留字符串值(README 里的配置块常有 null/嵌套等脏数据)
  const strMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return Object.keys(out).length ? out : undefined;
  };
  if (typeof e.command === 'string' && e.command.trim()) {
    return {
      transport: 'stdio',
      command: e.command,
      args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: strMap(e.env),
    };
  }
  const url = typeof e.url === 'string' && e.url.trim() ? e.url
    : typeof e.serverUrl === 'string' && e.serverUrl.trim() ? e.serverUrl
    : undefined;
  if (url) {
    const t = String(e.type ?? e.transport ?? '').toLowerCase();
    return { transport: t === 'sse' ? 'sse' : 'http', url, headers: strMap(e.headers) };
  }
  return null;
}
