/**
 * 项目档案 CRUD + activeProjectId 管理(projects.json)。
 */
import crypto from 'node:crypto';
import { projectsFile } from './paths.js';
import { atomicWriteJson, readJsonSafe } from './registry.js';
import type { Project, ProjectsData } from './types.js';

// 注意:不能复用模块级空对象常量——调用方会原地修改返回值的数组,
// 共享常量会导致跨调用污染(文件不存在/fallback 场景)。
export async function readProjects(): Promise<ProjectsData> {
  const data = await readJsonSafe<ProjectsData>(projectsFile(), { activeProjectId: null, projects: [] });
  if (!Array.isArray(data.projects)) return { activeProjectId: null, projects: [] };
  return { activeProjectId: data.activeProjectId ?? null, projects: [...data.projects] };
}

async function writeProjects(data: ProjectsData): Promise<void> {
  await atomicWriteJson(projectsFile(), data);
}

export async function listProjects(): Promise<ProjectsData> {
  return readProjects();
}

export async function getProject(id: string): Promise<Project | undefined> {
  const data = await readProjects();
  return data.projects.find((p) => p.id === id);
}

export async function createProject(input: {
  name: string;
  path: string;
  agents: string[];
  applyMode: 'symlink' | 'copy';
}): Promise<Project> {
  if (!input.name) throw new Error('项目名不能为空');
  if (!input.path) throw new Error('项目路径不能为空');
  const data = await readProjects();
  const project: Project = {
    id: crypto.randomUUID(),
    name: input.name,
    path: input.path,
    agents: input.agents ?? [],
    skills: [],
    applyMode: input.applyMode ?? 'symlink',
    createdAt: new Date().toISOString(),
  };
  data.projects.push(project);
  await writeProjects(data);
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'agents' | 'skills' | 'applyMode' | 'lastAppliedAt'>>,
): Promise<Project | undefined> {
  const data = await readProjects();
  const p = data.projects.find((x) => x.id === id);
  if (!p) return undefined;
  Object.assign(p, patch);
  await writeProjects(data);
  return p;
}

export async function deleteProject(id: string): Promise<boolean> {
  const data = await readProjects();
  const next = data.projects.filter((p) => p.id !== id);
  if (next.length === data.projects.length) return false;
  data.projects = next;
  if (data.activeProjectId === id) data.activeProjectId = null;
  await writeProjects(data);
  return true;
}

export async function setActiveProject(id: string | null): Promise<void> {
  const data = await readProjects();
  if (id !== null && !data.projects.some((p) => p.id === id)) {
    throw new Error(`项目不存在: ${id}`);
  }
  data.activeProjectId = id;
  await writeProjects(data);
}

/** 绑定/覆盖项目的技能集 */
export async function setProjectSkills(id: string, skillIds: string[]): Promise<Project | undefined> {
  return updateProject(id, { skills: skillIds });
}

/** 从所有项目的技能集中剔除指定 skill(uninstall 时调用,避免悬空引用) */
export async function detachSkillFromProjects(skillIds: string[]): Promise<void> {
  const ids = new Set(skillIds);
  const data = await readProjects();
  let dirty = false;
  for (const p of data.projects) {
    const next = p.skills.filter((s) => !ids.has(s));
    if (next.length !== p.skills.length) {
      p.skills = next;
      dirty = true;
    }
  }
  if (dirty) await writeProjects(data);
}
