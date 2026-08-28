import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter } from './types.js';

/** 各 agent 的用户级配置目录名(detect 依据)与项目级 skills 相对目录 */
interface AgentSpec {
  id: string;
  displayName: string;
  homeDir: string;       // ~/.xxx
  skillsSubDir: string;  // 项目内 .xxx/skills
  capabilities: { hooks: boolean; allowedTools: boolean };
}

export function makeAdapter(spec: AgentSpec): AgentAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    detect(): boolean {
      return fs.existsSync(path.join(os.homedir(), spec.homeDir));
    },
    projectSkillsDir(projectPath: string): string {
      return path.join(projectPath, spec.skillsSubDir);
    },
    capabilities: spec.capabilities,
  };
}
