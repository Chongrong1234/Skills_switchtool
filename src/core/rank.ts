/**
 * 技能热度排序:给项目选配技能时,把"常用 + 高星 + 贴合项目"的排在前面。
 *
 * 三个信号(权重刻意悬殊,顺序即优先级):
 * - 使用次数 useCount:用户自己绑过的最强信号,每次 +10;
 * - 项目分类匹配:技术栈/项目名关键词命中 skill 的 name/description/tags,每个 +6;
 * - 仓库 stars:社区热度,取 log10 压量纲(万星与千星不该差 10 倍),×4。
 * rankSkills 是稳定降序排序(同分保持注册表原顺序),不修改入参数组。
 */
import { detectTechStack } from './recommend.js';
import type { SkillEntry } from './types.js';

/** 排序上下文:一组小写关键词(技术栈 + 项目名分词) */
export interface RankContext {
  keywords: string[];
}

/** 空上下文:无项目信息时只剩 useCount/stars 两个信号 */
export const EMPTY_CONTEXT: RankContext = { keywords: [] };

/** 从项目档案构造排序上下文:技术栈标签 + 项目名分词(与 recommend.ts 的分词口径一致) */
export async function projectRankContext(projectPath: string, projectName: string): Promise<RankContext> {
  const stacks = await detectTechStack(projectPath);
  const words = projectName
    .split(/[\s\-_/.]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2);
  return { keywords: [...new Set([...stacks, ...words])] };
}

export function skillScore(skill: SkillEntry, ctx: RankContext = EMPTY_CONTEXT): number {
  let score = (skill.useCount ?? 0) * 10;
  if (skill.stars && skill.stars > 0) score += Math.log10(skill.stars + 1) * 4;
  if (ctx.keywords.length) {
    const haystack = `${skill.name} ${skill.description} ${(skill.tags ?? []).join(' ')}`.toLowerCase();
    for (const kw of ctx.keywords) {
      if (kw && haystack.includes(kw)) score += 6;
    }
  }
  return score;
}

/** 稳定降序:Array.prototype.sort 在 V8 是稳定的,同分保持注册表原顺序 */
export function rankSkills(skills: SkillEntry[], ctx: RankContext = EMPTY_CONTEXT): SkillEntry[] {
  return [...skills].sort((a, b) => skillScore(b, ctx) - skillScore(a, ctx));
}
