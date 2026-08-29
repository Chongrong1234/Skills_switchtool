/**
 * MCP server 中央注册表(mcps.json)。
 * 与 skills 不同,MCP server 是纯配置(命令/参数/URL),没有实体目录,
 * 所以全部状态就在这一个 JSON 文件里;name 即唯一键(写入 agent 配置时的 server 名)。
 */
import { mcpsFile } from './paths.js';
import { detachMcpFromProjects } from './projects.js';
import { atomicWriteJson, readJsonSafe } from './registry.js';
import type { McpEntry } from './types.js';

export class McpError extends Error {}

interface McpsData {
  mcps: McpEntry[];
}

export async function readMcps(): Promise<McpEntry[]> {
  const data = await readJsonSafe<McpsData>(mcpsFile(), { mcps: [] });
  return Array.isArray(data.mcps) ? data.mcps : [];
}

async function writeMcps(mcps: McpEntry[]): Promise<void> {
  await atomicWriteJson(mcpsFile(), { mcps });
}

export async function listMcps(): Promise<McpEntry[]> {
  return readMcps();
}

export async function getMcp(name: string): Promise<McpEntry | undefined> {
  const mcps = await readMcps();
  return mcps.find((m) => m.name === name);
}

/** server 名合法性:Claude Code 限制 ^[A-Za-z0-9_-]{1,64}$;同时保证 codex TOML 段名无需引号转义 */
export function assertValidMcpName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new McpError(`MCP server 名 "${name}" 非法:只能是字母/数字/下划线/连字符,1-64 字符`);
  }
}

/**
 * 新增或更新(按 name 覆盖)一个 MCP server。
 * stdio 必填 command;http/sse 必填 url;url 缺省按 http,sse 需显式 transport。
 */
export async function upsertMcp(input: {
  name: string;
  description?: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}): Promise<McpEntry> {
  assertValidMcpName(input.name);
  const transport = input.transport ?? (input.url ? 'http' : 'stdio');
  if (transport === 'stdio') {
    if (!input.command) throw new McpError('stdio 类型必须提供 command');
  } else if (!input.url) {
    throw new McpError(`${transport} 类型必须提供 url`);
  }
  const mcps = await readMcps();
  const entry: McpEntry = {
    name: input.name,
    description: input.description,
    transport,
    command: transport === 'stdio' ? input.command : undefined,
    args: transport === 'stdio' ? input.args : undefined,
    env: transport === 'stdio' ? input.env : undefined,
    cwd: transport === 'stdio' ? input.cwd : undefined,
    url: transport !== 'stdio' ? input.url : undefined,
    headers: transport !== 'stdio' ? input.headers : undefined,
    addedAt: mcps.find((m) => m.name === input.name)?.addedAt ?? new Date().toISOString(),
  };
  const idx = mcps.findIndex((m) => m.name === input.name);
  if (idx >= 0) mcps[idx] = entry;
  else mcps.push(entry);
  await writeMcps(mcps);
  return entry;
}

/** 删除一个 MCP server,并解除所有项目的绑定(避免悬空引用) */
export async function removeMcp(name: string): Promise<boolean> {
  const mcps = await readMcps();
  const next = mcps.filter((m) => m.name !== name);
  if (next.length === mcps.length) return false;
  await writeMcps(next);
  await detachMcpFromProjects([name]);
  return true;
}
