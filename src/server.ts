/**
 * Express 应用:REST API + 托管 public/ 单页应用。
 * 统一错误格式 { error: string }。
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from './adapters/index.js';
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
import { recommendForProject } from './core/recommend.js';
import { rollback } from './core/snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 统一把异步 handler 的错误交给错误中间件
const h = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

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
    if (!Array.isArray(skillIds)) return void res.status(400).json({ error: 'skillIds 必须是数组' });
    const project = await setProjectSkills(req.params.id, skillIds);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(project);
  }));

  // ---- skills ----
  app.get('/api/skills', h(async (_req, res) => {
    res.json(await listSkills());
  }));

  app.post('/api/skills', h(async (req, res) => {
    const { source, uri } = req.body ?? {};
    if (!source || !uri) return void res.status(400).json({ error: 'source 与 uri 必填' });
    if (source === 'github') return void res.status(201).json(await installFromGithub(uri));
    if (source === 'local') return void res.status(201).json(await installFromLocal(uri));
    res.status(400).json({ error: 'source 只能是 github 或 local' });
  }));

  app.delete('/api/skills/:id', h(async (req, res) => {
    const ok = await uninstall(req.params.id);
    if (!ok) return void res.status(404).json({ error: 'skill 不存在' });
    res.json({ ok: true });
  }));

  // 自建 skill 脚手架
  app.post('/api/skills/init', h(async (req, res) => {
    const { name, description } = req.body ?? {};
    if (!name || !description) return void res.status(400).json({ error: 'name 与 description 必填' });
    const entry = await initSkill(name, description);
    res.status(201).json(entry);
  }));

  // ---- recommend ----
  app.get('/api/recommend', h(async (req, res) => {
    const projectId = String(req.query.projectId ?? '');
    const project = await getProject(projectId);
    if (!project) return void res.status(404).json({ error: '项目不存在' });
    res.json(await recommendForProject(project.path, project.name));
  }));

  // 托管前端单页应用
  app.use(express.static(path.join(__dirname, '..', 'public')));

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
