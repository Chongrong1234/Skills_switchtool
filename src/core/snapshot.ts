/**
 * 快照与回滚:apply 前记录目标目录状态,rollback 还原;每项目保留最近 5 份。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { snapshotsDir } from './paths.js';

export interface SnapshotItem {
  agentId: string;
  targetPath: string;                 // 目标 agent skills 目录下的条目路径
  action: 'created' | 'conflict-moved';
  movedTo?: string;                   // conflict-moved 时,原内容被移到的快照内位置
}

export interface SnapshotManifest {
  projectId: string;
  createdAt: string;
  items: SnapshotItem[];
}

export interface SnapshotHandle {
  dir: string;
  manifest: SnapshotManifest;
}

const MAX_SNAPSHOTS = 5;

function projectSnapshotsDir(projectId: string): string {
  return path.join(snapshotsDir(), projectId);
}

/** 创建一份新快照(目录 + 空 manifest) */
export async function createSnapshot(projectId: string): Promise<SnapshotHandle> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(projectSnapshotsDir(projectId), stamp);
  await fs.mkdir(dir, { recursive: true });
  return { dir, manifest: { projectId, createdAt: new Date().toISOString(), items: [] } };
}

/** 记录"我们新建了 targetPath" */
export function recordCreated(snap: SnapshotHandle, agentId: string, targetPath: string): void {
  snap.manifest.items.push({ agentId, targetPath, action: 'created' });
}

/** 把冲突的既有内容移入快照,并记录 */
export async function moveConflictIntoSnapshot(
  snap: SnapshotHandle,
  agentId: string,
  targetPath: string,
): Promise<void> {
  const rel = path.join('conflicts', agentId, path.basename(targetPath));
  const movedTo = path.join(snap.dir, rel);
  await fs.mkdir(path.dirname(movedTo), { recursive: true });
  await fs.rename(targetPath, movedTo);
  snap.manifest.items.push({ agentId, targetPath, action: 'conflict-moved', movedTo: rel });
}

/** 写 manifest 并裁剪历史快照到最近 5 份 */
export async function finalizeSnapshot(snap: SnapshotHandle): Promise<void> {
  await fs.writeFile(path.join(snap.dir, 'manifest.json'), JSON.stringify(snap.manifest, null, 2), 'utf8');
  await pruneSnapshots(snap.manifest.projectId);
}

async function listSnapshotDirs(projectId: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(projectSnapshotsDir(projectId), { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function pruneSnapshots(projectId: string): Promise<void> {
  const names = await listSnapshotDirs(projectId);
  const excess = names.length - MAX_SNAPSHOTS;
  for (let i = 0; i < excess; i++) {
    await fs.rm(path.join(projectSnapshotsDir(projectId), names[i]), { recursive: true, force: true });
  }
}

/** 回滚:还原最近一次快照(删除我们创建的、移回冲突的),然后删除该快照 */
export async function rollback(projectId: string): Promise<{ restored: boolean; detail: string }> {
  const names = await listSnapshotDirs(projectId);
  if (names.length === 0) return { restored: false, detail: '没有可回滚的快照' };
  const dir = path.join(projectSnapshotsDir(projectId), names[names.length - 1]);
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return { restored: false, detail: '快照 manifest 损坏' };
  }
  // 逆序还原:先删创建的,再移回冲突的
  for (const item of [...manifest.items].reverse()) {
    if (item.action === 'created') {
      await fs.rm(item.targetPath, { recursive: true, force: true });
    } else if (item.action === 'conflict-moved' && item.movedTo) {
      await fs.rm(item.targetPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
      await fs.rename(path.join(dir, item.movedTo), item.targetPath);
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { restored: true, detail: `已回滚快照 ${names[names.length - 1]}` };
}

export async function listSnapshots(projectId: string): Promise<string[]> {
  return listSnapshotDirs(projectId);
}
