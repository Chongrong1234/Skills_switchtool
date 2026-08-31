/**
 * Express 应用:REST API + 托管 public/ 单页应用。
 * 统一错误格式 { error: string }。
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, getAdapter } from './adapters/index.js';
import { applyProject, unapplyProject } from './core/apply.js';
import { applyGlobal, readGlobal, rollbackGlobal, unapplyGlobal, updateGlobal } from './core/global.js';
import { exportProfile, importProfile } from './core/profile.js';
import {
  adoptFromAgent,
  adoptFromAllAgents,
  initSkill,
  installFromGithub,
  installFromLocal,
  LibraryError,
  listGitProgress,
  listSkills,
  uninstall,
} from './core/library.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setActiveProject,
  setProjectMcps,
  setProjectSkills,
  updateProject,
} from './core/projects.js';
import { listCatalogCategories, listCatalogWithInstalled } from './core/catalog.js';
import { exportSkillsCode, importSkillsCode, parseSkillsCode } from './core/migrate.js';
import { listMcps, McpError, removeMcp, upsertMcp } from './core/mcps.js';
import { recommendForProject } from './core/recommend.js';
import { EMPTY_CONTEXT, projectRankContext, rankSkills } from './core/rank.js';
import {
  AiError,
  AI_PRESETS,
  aiRecommendSkills,
  readAiConfig,
  testAiConnection,
  toPublicConfig,
  updateAiConfig,
} from './core/ai.js';
import { readRegistry } from './core/registry.js';
import { rollback } from './core/snapshot.js';
import { runDoctor } from './core/doctor.js';
import { VERSION } from './version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析 public/ 目录:从本文件位置逐级上探,取第一个存在 index.html 的 public/。
 * 覆盖三种布局:dist/(dev/打包 asar)、release/cli/(CLI 单文件)、以及项目根直跑。
 * 都找不到时返回第一候选(行为同旧版,静态页 404 但 API 仍可用)。
 */
function resolvePublicDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    dir = path.dirname(dir);
    const candidate = path.join(dir, 'public');
    if (fsSync.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return path.join(__dirname, '..', 'public');
}

// 统一把异步 handler 的错误交给错误中间件
const h = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/** 校验 agents 数组(与 CLI project create 行为一致);合法返回 null,否则返回错误信息 */
function validateAgents(agents: unknown): string | null {
  if (!Array.isArray(agents)) return 'agents 必须是数组';
  const unknown = agents.filter((id) => typeof id !== 'string' || !getAdapter(id));
  return unknown.length ? `未知 agent: ${unknown.join(', ')}` : null;
}

/** 校验 skillIds 数组且都存在于库中(与 CLI project bind 行为一致) */
async function validateSkillIds(skillIds: unknown): Promise<string | null> {
  if (!Array.isArray(skillIds)) return 'skillIds 必须是数组';
  const registry = await readRegistry();
  const missing = skillIds.filter((id) => !registry.some((s) => s.id === id));
  return missing.length ? `库中不存在这些 skill: ${missing.join(', ')}` : null;
}

/** 校验 mcpNames 数组且都存在于 MCP 注册表中(与 CLI project bind-mcp 行为一致) */
async function validateMcpNames(mcpNames: unknown): Promise<string | null> {
  if (!Array.isArray(mcpNames)) return 'mcpNames 必须是数组';
  const mcps = await listMcps();
  const missing = mcpNames.filter((n) => !mcps.some((m) => m.name === n));
  return missing.length ? `库中不存在这些 MCP server: ${missing.join(', ')}` : null;
}

export function createApp(): express.Express {
  const app = express();

  // 本机回环防护:服务无认证,恶意网页可用 simple request(不触发 preflight)跨域打
  // 127.0.0.1 的写端点(apply/rollback 等)。Host 必须指向回环(防 DNS rebinding 读密钥);
  // 带 Origin 的请求必是浏览器跨域,仅放行回环源。Electron 页面 loadURL 自 127.0.0.1,
  // 同源请求不带 Origin 或 Origin 即回环源,不受影响;CLI/TUI 不走本服务。
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      return void res.status(403).json({ error: '仅允许本机回环访问' });
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
      return void res.status(403).json({ error: '拒绝跨站来源的请求' });
    }
    next();
  });

  // 写请求进程内串行化:core 持久化是"读-改-写"JSON 且无锁,
  // GUI 连点/并发写会互相覆盖丢条目。GET 不排队,进度轮询等读接口不受影响。
  let writeQueue: Promise<unknown> = Promise.resolve();
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    writeQueue = writeQueue.then(
      () =>
        new Promise<void>((resolve) => {
          res.once('finish', resolve);
          res.once('close', resolve); // 客户端中途断连的兜底(finish 之后 resolve 是幂等的)
          next();
        }),
    );
  });

  // profile bundle 内嵌 local 技能 base64(单 skill 允许到 20MB),
  // express.json 默认 100KB 上限会把稍大的配置库导入直接 413 掉
  app.use(express.json({ limit: '50mb' }));

  // ---- agents ----
  app.get('/api/agents', (_req, res) => {
    res.json(
      adapters.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        detected: a.detect(),
        capabilities: a.capabilities,
      })),
    );
  });

  // ---- meta:服务进程信息(cwd 供前端预填/缺省项目路径)----
  app.get('/api/meta', (_req, res) => {
    res.json({ cwd: process.cwd() });
  });

  // ---- doctor:环境自检(桌面 GUI 设置弹窗的数据源;与 ssw doctor 同一份报告)----
  app.get('/api/doctor', h(async (_req, res) => {
    res.json({ version: VERSION, ...(await runDoctor()) });
  }));

  // ---- projects ----
  app.get('/api/projects', h(async (_req, res) => {
    res.json(await listProjects());
  }));

  app.post('/api/projects', h(async (req, res) => {
    const { name, path: p, agents, applyMode } = req.body ?? {};
    if (!name) return void res.status(400).json({ error: 'name 必填' });
    if (applyMode && !['symlink', 'copy'].includes(applyMode)) {
      return void res.status(400).json({ error: 'applyMode 只能是 symlink 或 copy' });
    }
    if (agents !== undefined) {
      const err = validateAgents(agents);
      if (err) return void res.status(400).json({ error: err });
    }
    // path 缺省取服务进程当前工作目录(与 CLI --path 缺省一致;服务通常就在项目根启动)
    const project = await createProject({ name, path: p || process.cwd(), agents: agents ?? [], applyMode: applyMode ?? 'symlink' });
    res.status(201).json(project);
  }));

  app.get('/api/projects/:id', h(async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(project);
  }));

  app.patch('/api/projects/:id', h(async (req, res) => {
    const { name, agents, skills, mcps, applyMode } = req.body ?? {};
    if (applyMode && !['symlink', 'copy'].includes(applyMode)) {
      return void res.status(400).json({ error: 'applyMode 只能是 symlink 或 copy' });
    }
    if (agents !== undefined) {
      const err = validateAgents(agents);
      if (err) return void res.status(400).json({ error: err });
    }
    if (skills !== undefined) {
      const err = await validateSkillIds(skills);
      if (err) return void res.status(400).json({ error: err });
    }
    if (mcps !== undefined) {
      const err = await validateMcpNames(mcps);
      if (err) return void res.status(400).json({ error: err });
    }
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (agents !== undefined) patch.agents = agents;
    if (skills !== undefined) patch.skills = skills;
    if (mcps !== undefined) patch.mcps = mcps;
    if (applyMode !== undefined) patch.applyMode = applyMode;
    const project = await updateProject(req.params.id, patch);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(project);
  }));

  app.delete('/api/projects/:id', h(async (req, res) => {
    const ok = await deleteProject(req.params.id);
    if (!ok) return void res.status(404).json({ error: '项目不存在' });
    res.json({ ok: true });
  }));

  // 切换:设为当前项目并 apply
  app.post('/api/projects/:id/switch', h(async (req, res) => {
    if (!(await getProject(req.params.id))) return void res.status(404).json({ error: '项目不存在' });
    await setActiveProject(req.params.id);
    const result = await applyProject(req.params.id);
    res.json({ activeProjectId: req.params.id, ...result });
  }));

  app.post('/api/projects/:id/apply', h(async (req, res) => {
    if (!(await getProject(req.params.id))) return void res.status(404).json({ error: '项目不存在' });
    res.json(await applyProject(req.params.id));
  }));

  app.post('/api/projects/:id/unapply', h(async (req, res) => {
    if (!(await getProject(req.params.id))) return void res.status(404).json({ error: '项目不存在' });
    res.json(await unapplyProject(req.params.id));
  }));

  app.post('/api/projects/:id/rollback', h(async (req, res) => {
    if (!(await getProject(req.params.id))) return void res.status(404).json({ error: '项目不存在' });
    res.json(await rollback(req.params.id));
  }));

  // 绑定/更新项目技能集
  app.post('/api/projects/:id/skills', h(async (req, res) => {
    const { skillIds } = req.body ?? {};
    const err = await validateSkillIds(skillIds);
    if (err) return void res.status(400).json({ error: err });
    const project = await setProjectSkills(req.params.id, skillIds);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(project);
  }));

  // 绑定/更新项目 MCP 服务集
  app.post('/api/projects/:id/mcps', h(async (req, res) => {
    const { mcpNames } = req.body ?? {};
    const err = await validateMcpNames(mcpNames);
    if (err) return void res.status(400).json({ error: err });
    const project = await setProjectMcps(req.params.id, mcpNames);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(project);
  }));

  // ---- MCP server 注册表 ----
  app.get('/api/mcps', h(async (_req, res) => {
    res.json(await listMcps());
  }));

  app.post('/api/mcps', h(async (req, res) => {
    const { name, description, transport, command, args, env, cwd, url, headers } = req.body ?? {};
    if (!name) return void res.status(400).json({ error: 'name 必填' });
    const entry = await upsertMcp({ name, description, transport, command, args, env, cwd, url, headers });
    res.status(201).json(entry);
  }));

  app.delete('/api/mcps/:name', h(async (req, res) => {
    const ok = await removeMcp(req.params.name);
    if (!ok) return void res.status(404).json({ error: 'MCP server 不存在' });
    res.json({ ok: true });
  }));

  // ---- skills ----
  // ?rank=1 按热度排序(使用次数 > 项目分类匹配 > stars);&forProject=<id> 带该项目的技术栈/名词上下文
  app.get('/api/skills', h(async (req, res) => {
    const skills = await listSkills();
    if (req.query.rank !== '1') return void res.json(skills);
    let ctx = EMPTY_CONTEXT;
    const pid = req.query.forProject ? String(req.query.forProject) : '';
    if (pid) {
      const p = await getProject(pid);
      if (!p) return void res.status(404).json({ error: '项目不存在' });
      ctx = await projectRankContext(p.path, p.name);
    }
    res.json(rankSkills(skills, ctx));
  }));

  // git 任务进度:安装/更新的 clone/pull 进度,GUI/Electron 轮询渲染进度条
  app.get('/api/progress', (_req, res) => {
    res.json({ jobs: listGitProgress() });
  });

  // 迁移码:导出库中 github 来源的仓库简写集合;导入即逐仓安装(局部失败不中断)
  app.get('/api/skills/export', h(async (_req, res) => {
    const code = exportSkillsCode(await listSkills());
    res.json({ code, repos: parseSkillsCode(code) });
  }));

  app.post('/api/skills/import', h(async (req, res) => {
    const { code } = req.body ?? {};
    if (!code || typeof code !== 'string') return void res.status(400).json({ error: 'code 必填' });
    res.json(await importSkillsCode(code));
  }));

  app.post('/api/skills', h(async (req, res) => {
    const { source, uri, subdir } = req.body ?? {};
    if (!source || !uri) return void res.status(400).json({ error: 'source 与 uri 必填' });
    // subdir 仅对 github 来源有意义:以仓库内该子目录为扫描根(合集仓库常见 skills/)
    if (subdir !== undefined && typeof subdir !== 'string') {
      return void res.status(400).json({ error: 'subdir 必须是字符串' });
    }
    if (source === 'github') return void res.status(201).json(await installFromGithub(uri, subdir));
    if (source === 'local') {
      if (subdir !== undefined) return void res.status(400).json({ error: 'subdir 仅支持 github 来源' });
      return void res.status(201).json(await installFromLocal(uri));
    }
    res.status(400).json({ error: 'source 只能是 github 或 local' });
  }));

  app.delete('/api/skills/:id', h(async (req, res) => {
    const r = await uninstall(req.params.id);
    if (!r.removed) return void res.status(404).json({ error: 'skill 不存在' });
    res.json({ ok: true, alsoRemoved: r.alsoRemoved });
  }));

  // 自建 skill 脚手架;content 可选:粘贴的完整 SKILL.md(frontmatter 兜底 name/description)或纯正文
  app.post('/api/skills/init', h(async (req, res) => {
    const { name, description, content } = req.body ?? {};
    if (content !== undefined && typeof content !== 'string') {
      return void res.status(400).json({ error: 'content 必须是字符串' });
    }
    // name/description 的具体校验(含 frontmatter 兜底)在 initSkill 内,LibraryError 统一映射 400
    const entry = await initSkill(name ?? '', description ?? '', content);
    res.status(201).json(entry);
  }));

  // ---- catalog 推荐库(内置精选目录,安装复用 POST /api/skills;categories 带条目统计)----
  // ?kind=skill|mcp 把 skills 与 MCP 的浏览/下载分流(缺省混排,向后兼容)
  app.get('/api/catalog', h(async (req, res) => {
    const category = req.query.category ? String(req.query.category) : undefined;
    const query = req.query.q ? String(req.query.q) : undefined;
    const kind = req.query.kind ? String(req.query.kind) : undefined;
    if (kind !== undefined && kind !== 'skill' && kind !== 'mcp') {
      return void res.status(400).json({ error: 'kind 只能是 skill 或 mcp' });
    }
    res.json({
      categories: listCatalogCategories(),
      items: await listCatalogWithInstalled({ category, query, kind }),
    });
  }));

  // ---- recommend ----
  app.get('/api/recommend', h(async (req, res) => {
    const projectId = String(req.query.projectId ?? '');
    const project = await getProject(projectId);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(await recommendForProject(project.path, project.name));
  }));

  // ---- AI 推荐(模型读本地技能库 + 用户需求;配置在设置弹窗 / ssw ai config)----
  // GET 只回掩码后的配置 + 可选预设,绝不回 apiKey 原文
  app.get('/api/ai/config', h(async (_req, res) => {
    res.json({ ...toPublicConfig(await readAiConfig()), presets: AI_PRESETS });
  }));

  // PUT:undefined 字段保持不变;apiKey 传空串 = 显式清除(校验错误抛 AiError → 400)
  app.put('/api/ai/config', h(async (req, res) => {
    const { baseUrl, model, apiKey } = req.body ?? {};
    for (const [k, v] of Object.entries({ baseUrl, model, apiKey })) {
      if (v !== undefined && typeof v !== 'string') {
        return void res.status(400).json({ error: `${k} 必须是字符串` });
      }
    }
    res.json({ ...toPublicConfig(await updateAiConfig({ baseUrl, model, apiKey })), presets: AI_PRESETS });
  }));

  // 测试连接:body 里的字段优先于已存配置(保存前先测);走与推荐相同的 chat/completions 路径
  app.post('/api/ai/test', h(async (req, res) => {
    const { baseUrl, model, apiKey } = req.body ?? {};
    res.json(await testAiConnection({ baseUrl, model, apiKey }));
  }));

  app.post('/api/ai/recommend', h(async (req, res) => {
    const { requirement, projectName } = req.body ?? {};
    if (!requirement || typeof requirement !== 'string') {
      return void res.status(400).json({ error: 'requirement 必填(一两句话描述开发需求)' });
    }
    res.json(await aiRecommendSkills({ requirement, projectName: typeof projectName === 'string' ? projectName : undefined }));
  }));

  // 收养:把 agent 目录(user 级或项目级)里已有的 skills 复制进中央库(逆向于 apply);
  // all:true 时一次扫描所有 agent(同名跨 agent 去重,同目录只扫一次)
  app.post('/api/skills/adopt', h(async (req, res) => {
    const { agent, scope, projectPath, all } = req.body ?? {};
    if (scope !== undefined && !['user', 'project'].includes(scope)) {
      return void res.status(400).json({ error: 'scope 只能是 user 或 project' });
    }
    if (all === true) {
      // 一键收养缺省 user 级("本机配过的 skills"主要指各 agent 全局目录);项目级路径缺省取 cwd
      return void res.json(await adoptFromAllAgents({ scope: scope ?? 'user', projectPath: projectPath || process.cwd() }));
    }
    if (!agent || typeof agent !== 'string') return void res.status(400).json({ error: 'agent 必填(或传 all: true 收养所有 agent)' });
    // 项目级作用域的路径缺省取服务进程 cwd(与 POST /api/projects 的约定一致)
    res.json(await adoptFromAgent(agent, { scope: scope ?? 'project', projectPath: projectPath || process.cwd() }));
  }));

  // ---- global 全局(用户级)共享:一次配置,所有项目共享 ----
  app.get('/api/global', h(async (_req, res) => {
    res.json(await readGlobal());
  }));

  app.put('/api/global', h(async (req, res) => {
    const { skills, agents, applyMode } = req.body ?? {};
    if (applyMode !== undefined && !['symlink', 'copy'].includes(applyMode)) {
      return void res.status(400).json({ error: 'applyMode 只能是 symlink 或 copy' });
    }
    if (skills !== undefined) {
      const err = await validateSkillIds(skills);
      if (err) return void res.status(400).json({ error: err });
    }
    if (agents !== undefined) {
      const err = validateAgents(agents);
      if (err) return void res.status(400).json({ error: err });
    }
    const patch: Parameters<typeof updateGlobal>[0] = {};
    if (skills !== undefined) patch.skills = skills;
    if (agents !== undefined) patch.agents = agents;
    if (applyMode !== undefined) patch.applyMode = applyMode;
    res.json(await updateGlobal(patch));
  }));

  app.post('/api/global/apply', h(async (_req, res) => {
    res.json(await applyGlobal());
  }));

  app.post('/api/global/unapply', h(async (_req, res) => {
    res.json(await unapplyGlobal());
  }));

  app.post('/api/global/rollback', h(async (_req, res) => {
    res.json(await rollbackGlobal());
  }));

  // ---- profile 配置库导出/导入(跨机器/跨平台共享,含 local 技能与项目档案)----
  app.get('/api/profile/export', h(async (_req, res) => {
    res.json(await exportProfile());
  }));

  app.post('/api/profile/import', h(async (req, res) => {
    const { bundle } = req.body ?? {};
    if (!bundle) return void res.status(400).json({ error: 'bundle 必填' });
    res.json(await importProfile(bundle));
  }));

  // 托管前端单页应用
  app.use(express.static(resolvePublicDir()));

  // 统一错误处理
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg =
      err instanceof LibraryError ? err.message :
      err instanceof McpError ? err.message :
      err instanceof AiError ? err.message :
      err instanceof Error ? err.message : String(err);
    const status = err instanceof LibraryError || err instanceof McpError || err instanceof AiError ? 400 : 500;
    res.status(status).json({ error: msg });
  });

  return app;
}
