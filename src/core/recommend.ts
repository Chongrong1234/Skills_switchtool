/**
 * 推荐引擎:技术栈检测(清单文件)+ GitHub Search API 按 star 排序。
 * 缓存 24h(~/.skills-switch/cache/);断网/限流降级为返回空数组 + 说明,绝不抛异常。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cacheDir } from './paths.js';

export interface Recommendation {
  name: string;
  repo: string;
  url: string;
  stars: number;
  description: string;
  reason: string;
}

export interface RecommendResult {
  items: Recommendation[];
  message?: string; // 降级说明(断网/限流/无结果)
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 技术栈检测:扫项目根清单文件 */
export async function detectTechStack(projectPath: string): Promise<string[]> {
  const stacks: string[] = [];
  const has = async (f: string) => {
    try {
      await fs.access(path.join(projectPath, f));
      return true;
    } catch {
      return false;
    }
  };
  if (await has('package.json')) {
    stacks.push('node');
    // package.json 里含 typescript 依赖或存在 tsconfig.json → ts
    let isTs = await has('tsconfig.json');
    if (!isTs) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        isTs = 'typescript' in deps;
      } catch {
        /* package.json 损坏时忽略 */
      }
    }
    if (isTs) stacks.push('typescript');
  }
  if (await has('go.mod')) stacks.push('go');
  if (await has('Cargo.toml')) stacks.push('rust');
  if (await has('pyproject.toml')) stacks.push('python');
  return stacks;
}

type FetchLike = typeof fetch;

interface GithubRepo {
  full_name: string;
  name: string;
  html_url: string;
  stargazers_count: number;
  description: string | null;
}

/** 调 GitHub Search API(可注入 fetch 便于测试) */
export async function searchGithubSkills(
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<GithubRepo[]> {
  const url =
    'https://api.github.com/search/repositories?q=' +
    encodeURIComponent(query) +
    '&sort=stars&order=desc&per_page=10';
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'skills-switchtool' },
  });
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  const data = (await res.json()) as { items?: GithubRepo[] };
  return data.items ?? [];
}

function cacheFileFor(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(cacheDir(), `recommend-${hash}.json`);
}

async function readCache(key: string): Promise<GithubRepo[] | null> {
  try {
    const file = cacheFileFor(key);
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(data.items) ? data.items : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, items: GithubRepo[]): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cacheFileFor(key), JSON.stringify({ items }), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/**
 * 为项目生成推荐:技术栈标签 + 项目名关键词 → GitHub 搜索,按 star 降序取 Top 10。
 * 任何网络/解析失败都降级为 { items: [], message },不抛异常。
 */
export async function recommendForProject(
  projectPath: string,
  projectName: string,
  fetchImpl: FetchLike = fetch,
): Promise<RecommendResult> {
  try {
    const stacks = await detectTechStack(projectPath);
    const keywords = projectName
      .split(/[\s\-_/.]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3);

    // 查询词:topic:agent-skills + 技术栈/关键词,最多拼 3 个避免过长
    const terms = [...stacks, ...keywords].slice(0, 3);
    const query = ['topic:agent-skills', ...terms].join(' ');

    let repos = await readCache(query);
    if (!repos) {
      repos = await searchGithubSkills(query, fetchImpl);
      await writeCache(query, repos);
    }

    const items: Recommendation[] = repos
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 10)
      .map((r) => {
        const reasons: string[] = [];
        const haystack = `${r.full_name} ${r.description ?? ''}`.toLowerCase();
        for (const s of stacks) if (haystack.includes(s)) reasons.push(`技术栈匹配: ${s}`);
        for (const k of keywords) if (haystack.includes(k.toLowerCase())) reasons.push(`关键词匹配: ${k}`);
        if (reasons.length === 0) reasons.push('GitHub 高星 agent-skills 仓库');
        return {
          name: r.name,
          repo: r.full_name,
          url: r.html_url,
          stars: r.stargazers_count,
          description: r.description ?? '',
          reason: reasons.join(';'),
        };
      });

    return {
      items,
      message: items.length === 0 ? '没有找到匹配的推荐' : undefined,
    };
  } catch (err) {
    // 断网/限流/任何异常:降级返回空数组 + 说明
    return {
      items: [],
      message: `推荐不可用(已降级): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
