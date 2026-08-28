/**
 * 迁移码:把库中 GitHub 来源的 skills 编码成一段紧凑字符串("ssw1:owner/repo,..."),
 * 粘贴到新环境即可批量下载还原。仅限 github 来源——local/init 是本机内容,无法跨机迁移。
 * 粒度为仓库:installFromGithub 按整仓克隆并登记其中全部 skill,仓库级即可完整还原库状态。
 */
import { installFromGithub, LibraryError } from './library.js';
import { readRegistry } from './registry.js';
import type { SkillEntry } from './types.js';

/** 迁移码前缀,兼作格式版本号:以后换格式时可识别旧码并报出明确错误 */
export const MIGRATE_CODE_PREFIX = 'ssw1:';

/** github 来源条目 → 迁移码。按仓库去重并排序,同一批 skills 输出稳定 */
export function exportSkillsCode(skills: SkillEntry[]): string {
  const repos = [
    ...new Set(
      skills.filter((s) => s.source.type === 'github').map((s) => s.id.split(':')[0]),
    ),
  ].sort();
  return MIGRATE_CODE_PREFIX + repos.join(',');
}

/** 解析迁移码 → 仓库简写列表。容忍逗号/空白/换行混排;格式非法抛 LibraryError */
export function parseSkillsCode(code: string): string[] {
  const trimmed = (code ?? '').trim();
  if (!trimmed.startsWith(MIGRATE_CODE_PREFIX)) {
    throw new LibraryError(`迁移码格式不正确:应以 "${MIGRATE_CODE_PREFIX}" 开头`);
  }
  const tokens = trimmed.slice(MIGRATE_CODE_PREFIX.length).split(/[\s,]+/).filter(Boolean);
  const bad = tokens.filter((t) => !/^[^/\s]+\/[^/\s]+$/.test(t));
  if (bad.length) {
    throw new LibraryError(`迁移码包含无法识别的条目: ${bad.join(', ')}(应为 owner/repo)`);
  }
  return [...new Set(tokens)];
}

export interface ImportSkillsResult {
  installed: string[];                         // 本次新安装的仓库
  skipped: string[];                           // 已在库中、跳过的仓库
  failed: { repo: string; message: string }[]; // 安装失败的仓库(断网/仓库不存在等)
}

/**
 * 导入迁移码:逐仓库安装。已在库中的跳过(幂等);
 * 单仓失败只记入 failed、不中断其余(降级而非崩溃)。
 * installFn 可注入,测试时避免真实 git clone(同 recommendForProject 注入 fetch 的做法)。
 */
export async function importSkillsCode(
  code: string,
  installFn: (uri: string) => Promise<SkillEntry[]> = installFromGithub,
): Promise<ImportSkillsResult> {
  const repos = parseSkillsCode(code);
  const existing = new Set(
    (await readRegistry())
      .filter((s) => s.source.type === 'github')
      .map((s) => s.id.split(':')[0]),
  );
  const result: ImportSkillsResult = { installed: [], skipped: [], failed: [] };
  for (const repo of repos) {
    if (existing.has(repo)) {
      result.skipped.push(repo);
      continue;
    }
    try {
      await installFn(repo);
      result.installed.push(repo);
    } catch (err) {
      result.failed.push({ repo, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
