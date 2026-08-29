/**
 * MCP 物化:把项目绑定的 MCP server 合并写入各 agent 的项目级配置文件。
 * 与 skills 的目录物化不同,这里是"编辑共享配置文件":
 *   - 合并而非整写:保留文件里用户自己的其它 server,只增改我们管理的同名条目;
 *   - 快照:已存在的配置文件先整体移入快照(conflict-moved)再写合并结果,
 *     rollback 自动还原;文件不存在则记 created(rollback 删除);
 *   - 幂等:合并结果与现有内容一致则跳过,不动快照;
 *   - codex 走 config.toml 的 [mcp_servers.*] 段,块级文本合并(不引入 TOML 解析依赖)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAdapter } from '../adapters/index.js';
import { readMcps } from './mcps.js';
import {
  moveConflictIntoSnapshot,
  recordCreated,
  type SnapshotHandle,
} from './snapshot.js';
import type { McpEntry, Project } from './types.js';

export interface McpAppliedItem {
  agentId: string;
  mcpName: string;
  target: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** 键排序后的稳定序列化,用于"内容是否一致"的幂等比较 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------- mcpServers JSON 系(claude-code / cursor / kimi-code) ----------

interface JsonMcpFile {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}

function parseJsonMcpFile(raw: string): JsonMcpFile | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const servers = parsed.mcpServers;
    return {
      ...parsed,
      mcpServers:
        servers !== null && typeof servers === 'object' && !Array.isArray(servers)
          ? (servers as Record<string, unknown>)
          : {},
    };
  } catch {
    return null; // JSON 损坏
  }
}

// ---------- codex config.toml 的 [mcp_servers.*] 段 ----------

const MCP_SECTION_RE = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]\s*$/;
const ANY_SECTION_RE = /^\s*\[/;

/** 收集 config.toml 文本中全部 [mcp_servers.*] 段名(unapply 归属判断用) */
export function listTomlMcpSectionNames(existing: string): Set<string> {
  const names = new Set<string>();
  for (const line of existing.split('\n')) {
    const m = line.match(MCP_SECTION_RE);
    if (m) names.add(m[1] ?? m[2] ?? m[3]);
  }
  return names;
}

/** 从 config.toml 文本中摘掉 names 里列出的 server 段(含 [mcp_servers.<name>.xxx] 子表) */
export function removeTomlMcpSections(existing: string, names: ReadonlySet<string>): string {
  const lines = existing.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (ANY_SECTION_RE.test(line)) {
      const m = line.match(MCP_SECTION_RE);
      const sectionName = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
      skipping = sectionName !== undefined && names.has(sectionName);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** TOML 基础字符串:只转义反斜杠与双引号(配置里不应出现控制字符) */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 内联表/普通键:合法裸键直接写,否则加引号 */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function tomlValue(v: unknown): string {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const pairs = Object.entries(v as Record<string, unknown>).map(([k, val]) => `${tomlKey(k)} = ${tomlValue(val)}`);
    return `{ ${pairs.join(', ')} }`;
  }
  throw new Error(`无法序列化为 TOML 的值: ${String(v)}`);
}

/** 生成一个 [mcp_servers.<name>] 段(name 已限定 [A-Za-z0-9_-],无需引号) */
export function toTomlMcpSection(name: string, cfg: Record<string, unknown>): string {
  const lines = [`[mcp_servers.${name}]`];
  for (const [k, v] of Object.entries(cfg)) {
    lines.push(`${k} = ${tomlValue(v)}`);
  }
  return lines.join('\n');
}

/**
 * 合并 config.toml:先摘掉我们的旧段,再在末尾追加新段。
 * 返回值 === existing 表示内容无变化(幂等判断用)。
 */
export function mergeTomlMcpSections(
  existing: string,
  servers: { name: string; cfg: Record<string, unknown> }[],
): string {
  const names = new Set(servers.map((s) => s.name));
  let text = removeTomlMcpSections(existing, names);
  if (!servers.length) return text;
  text = text.trimEnd();
  const blocks = servers.map((s) => toTomlMcpSection(s.name, s.cfg));
  return (text ? `${text}\n\n` : '') + blocks.join('\n\n') + '\n';
}

// ---------- apply / unapply ----------

/** 收集项目绑定的 MCP 条目;悬空引用(注册表缺失)警告并跳过 */
async function resolveProjectMcps(project: Project, warnings: string[]): Promise<McpEntry[]> {
  const registry = await readMcps();
  const entries: McpEntry[] = [];
  for (const name of project.mcps) {
    const entry = registry.find((m) => m.name === name);
    if (!entry) {
      warnings.push(`库中找不到 MCP server: ${name},已跳过(可重新添加或 bind-mcp 移除该引用)`);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 把项目 MCP 服务集物化到各 agent 配置文件,变更记入 snap。
 * 返回实际写入的条目;内容已一致时幂等跳过(不进快照)。
 */
export async function applyProjectMcps(
  project: Project,
  snap: SnapshotHandle,
  warnings: string[],
): Promise<McpAppliedItem[]> {
  const applied: McpAppliedItem[] = [];
  if (!project.mcps.length) return applied;
  const entries = await resolveProjectMcps(project, warnings);
  if (!entries.length) return applied;

  for (const agentId of project.agents) {
    const adapter = getAdapter(agentId);
    if (!adapter) {
      warnings.push(`未知 agent: ${agentId},已跳过`);
      continue;
    }
    if (!adapter.mcp) {
      warnings.push(`agent ${agentId} 不支持项目级 MCP 配置,已跳过`);
      continue;
    }
    const target = adapter.mcp.configPath(project.path);
    const existing = (await pathExists(target)) ? await fs.readFile(target, 'utf8') : null;

    if (adapter.mcp.format === 'json') {
      // JSON 损坏:无法安全合并,按冲突处理——原文件整体进快照,重写为仅含我们的条目
      const file = existing !== null ? parseJsonMcpFile(existing) : { mcpServers: {} };
      if (file === null) {
        warnings.push(`${target} 的 JSON 已损坏,原文件已备份进快照,重写为仅含本项目 MCP 条目`);
      }
      const base: JsonMcpFile = file ?? { mcpServers: {} };
      for (const e of entries) {
        base.mcpServers[e.name] = adapter.mcp.toServerConfig(e);
      }
      if (existing !== null && file !== null && stableStringify(file) === stableStringify(base)) {
        continue; // 内容一致,幂等跳过
      }
      if (existing !== null) await moveConflictIntoSnapshot(snap, agentId, target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(base, null, 2) + '\n', 'utf8');
      if (existing === null) recordCreated(snap, agentId, target);
    } else {
      // codex config.toml:块级文本合并
      const merged = mergeTomlMcpSections(
        existing ?? '',
        entries.map((e) => ({ name: e.name, cfg: adapter.mcp!.toServerConfig(e) })),
      );
      if (merged === existing) continue; // 内容一致,幂等跳过(existing 为 null 时 merged 非空,必写)
      if (existing !== null) await moveConflictIntoSnapshot(snap, agentId, target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, merged, 'utf8');
      if (existing === null) recordCreated(snap, agentId, target);
    }
    for (const e of entries) applied.push({ agentId, mcpName: e.name, target });
  }
  return applied;
}

/**
 * unapply:从各 agent 配置文件中摘掉项目绑定的 MCP 条目(只动我们管理的名字)。
 * 摘空后文件不再含任何内容(JSON 仅剩空 mcpServers / TOML 成空白)则删除文件。
 */
export async function unapplyProjectMcps(project: Project): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  if (!project.mcps.length) return { removed };
  const names = new Set(project.mcps);

  for (const agentId of project.agents) {
    const adapter = getAdapter(agentId);
    if (!adapter?.mcp) continue;
    const target = adapter.mcp.configPath(project.path);
    if (!(await pathExists(target))) continue;

    if (adapter.mcp.format === 'json') {
      const file = parseJsonMcpFile(await fs.readFile(target, 'utf8'));
      if (!file) continue; // 文件损坏:不碰,留给用户手动处理
      let touched = false;
      for (const name of names) {
        if (name in file.mcpServers) {
          delete file.mcpServers[name];
          touched = true;
          removed.push(`${agentId}:${name}`);
        }
      }
      if (!touched) continue;
      const rest = Object.keys(file).filter((k) => k !== 'mcpServers');
      if (!Object.keys(file.mcpServers).length && !rest.length) {
        await fs.rm(target, { force: true }); // 文件里只剩我们的条目,整体删除
      } else {
        await fs.writeFile(target, JSON.stringify(file, null, 2) + '\n', 'utf8');
      }
    } else {
      const existing = await fs.readFile(target, 'utf8');
      const present = listTomlMcpSectionNames(existing);
      const merged = removeTomlMcpSections(existing, names);
      if (merged === existing) continue;
      for (const name of names) {
        if (present.has(name)) removed.push(`${agentId}:${name}`);
      }
      if (!merged.trim()) await fs.rm(target, { force: true });
      else await fs.writeFile(target, merged, 'utf8');
    }
  }
  return { removed };
}
