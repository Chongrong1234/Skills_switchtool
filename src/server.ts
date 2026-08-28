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
import {
  initSkill,
  installFromGithub,
  installFromLocal,
  LibraryError,
  listSkills,
  uninstall,
} from './core/library.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setActiveProject,
  setProjectSkills,
  updateProject,
} from './core/projects.js';
import { CATALOG_CATEGORIES, listCatalogWithInstalled } from './core/catalog.js';
import { exportSkillsCode, importSkillsCode, parseSkillsCode } from './core/migrate.js';
import { recommendForProject } from './core/recommend.js';
import { readRegistry } from './core/registry.js';
import { rollback } from './core/snapshot.js';

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

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

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

  // ---- projects ----
  app.get('/api/projects', h(async (_req, res) => {
    res.json(await listProjects());
  }));

  app.post('/api/projects', h(async (req, res) => {
    const { name, path: p, agents, applyMode } = req.body ?? {};
    if (!name || !p) return void res.status(400).json({ error: 'name 与 path 必填' });
    if (applyMode && !['symlink', 'copy'].includes(applyMode)) {
      return void res.status(400).json({ error: 'applyMode 只能是 symlink 或 copy' });
    }
    if (agents !== undefined) {
      const err = validateAgents(agents);
      if (err) return void res.status(400).json({ error: err });
    }
    const project = await createProject({ name, path: p, agents: agents ?? [], applyMode: applyMode ?? 'symlink' });
    res.status(201).json(project);
  }));

  app.get('/api/projects/:id', h(async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(project);
  }));

  app.patch('/api/projects/:id', h(async (req, res) => {
    const { name, agents, skills, applyMode } = req.body ?? {};
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
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (agents !== undefined) patch.agents = agents;
    if (skills !== undefined) patch.skills = skills;
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

  // ---- skills ----
  app.get('/api/skills', h(async (_req, res) => {
    res.json(await listSkills());
  }));

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

  // 自建 skill 脚手架
  app.post('/api/skills/init', h(async (req, res) => {
    const { name, description } = req.body ?? {};
    if (!name || !description) return void res.status(400).json({ error: 'name 与 description 必填' });
    const entry = await initSkill(name, description);
    res.status(201).json(entry);
  }));

  // ---- catalog 推荐库(内置精选目录,安装复用 POST /api/skills)----
  app.get('/api/catalog', h(async (req, res) => {
    const category = req.query.category ? String(req.query.category) : undefined;
    const query = req.query.q ? String(req.query.q) : undefined;
    res.json({
      categories: CATALOG_CATEGORIES,
      items: await listCatalogWithInstalled({ category, query }),
    });
  }));

  // ---- recommend ----
  app.get('/api/recommend', h(async (req, res) => {
    const projectId = String(req.query.projectId ?? '');
    const project = await getProject(projectId);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(await recommendForProject(project.path, project.name));
  }));

  // 托管前端单页应用
  app.use(express.static(resolvePublicDir()));

  // 统一错误处理
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg =
      err instanceof LibraryError ? err.message :
      err instanceof Error ? err.message : String(err);
    const status = err instanceof LibraryError ? 400 : 500;
    res.status(status).json({ error: msg });
  });

  return app;
}
