/**
 * ai 测试:配置读写/校验/掩码 + 端点归一 + 模型输出解析 + 推荐与测连流程。
 * 网络层一律注入假 fetch,不访问真实模型 API。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PRESETS,
  AiError,
  aiRecommendSkills,
  chatEndpoint,
  fallbackGithubKeywords,
  parseAiGithubKeywords,
  parseAiRecommendations,
  readAiConfig,
  testAiConnection,
  toPublicConfig,
  updateAiConfig,
} from '../src/core/ai.js';
import { upsertSkill, writeRegistry } from '../src/core/registry.js';
import type { SkillEntry } from '../src/core/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-test-'));
  process.env.SSW_HOME = tmp;
});

afterEach(async () => {
  delete process.env.SSW_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 往库里塞两个 skill 供推荐挑选 */
async function seedSkills(): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [
    { id: 'local:review', name: 'code-review', description: '代码审查与改进建议', source: { type: 'local', uri: '/x' }, tags: ['review'], installedAt: new Date().toISOString() },
    { id: 'local:test', name: 'unit-test', description: '单元测试生成', source: { type: 'local', uri: '/x' }, tags: [], installedAt: new Date().toISOString() },
  ];
  await writeRegistry(skills);
  return skills;
}

/** 假 fetch:chat/completions 返回 content;api.github.com 返回 ghItems。capture 只记 chat 调用细节,ghQueries 记 GitHub 查询 */
function mockAiFetch(
  content: string,
  capture?: { url?: unknown; body?: any; headers?: any; ghQueries?: string[] },
  ghItems: unknown[] = [],
) {
  return vi.fn(async (url: unknown, init?: { body: string; headers: unknown }) => {
    const u = String(url);
    if (u.includes('api.github.com')) {
      if (capture) (capture.ghQueries = capture.ghQueries ?? []).push(decodeURIComponent(u));
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: ghItems }),
        text: async () => '',
      };
    }
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(init!.body);
      capture.headers = init!.headers;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

describe('AI 配置(ai.json)', () => {
  it('文件缺失时回落到首个预设(Kimi),apiKey 为空', async () => {
    const cfg = await readAiConfig();
    expect(cfg.baseUrl).toBe(AI_PRESETS[0].baseUrl);
    expect(cfg.model).toBe(AI_PRESETS[0].models[0]);
    expect(cfg.apiKey).toBe('');
  });

  it('更新往返;undefined 字段保持不变;apiKey 空串显式清除', async () => {
    await updateAiConfig({ baseUrl: 'https://relay.example.com/v1', model: 'relay-model', apiKey: 'sk-abc12345' });
    let cfg = await readAiConfig();
    expect(cfg).toEqual({ baseUrl: 'https://relay.example.com/v1', model: 'relay-model', apiKey: 'sk-abc12345' });
    // 只改 model,其余保持
    await updateAiConfig({ model: 'other-model' });
    cfg = await readAiConfig();
    expect(cfg.baseUrl).toBe('https://relay.example.com/v1');
    expect(cfg.apiKey).toBe('sk-abc12345');
    // 空串 = 清除 key
    await updateAiConfig({ apiKey: '' });
    expect((await readAiConfig()).apiKey).toBe('');
  });

  it('非法 baseUrl / 空 model 抛 AiError', async () => {
    await expect(updateAiConfig({ baseUrl: 'ftp://x' })).rejects.toBeInstanceOf(AiError);
    await expect(updateAiConfig({ baseUrl: 'not-a-url' })).rejects.toBeInstanceOf(AiError);
    await expect(updateAiConfig({ model: '  ' })).rejects.toBeInstanceOf(AiError);
  });

  it('ai.json 字段类型损坏时字段级容错,不崩溃', async () => {
    await fs.writeFile(path.join(tmp, 'ai.json'), JSON.stringify({ baseUrl: 123, model: null, apiKey: 42 }), 'utf8');
    const cfg = await readAiConfig();
    expect(cfg.baseUrl).toBe(AI_PRESETS[0].baseUrl);
    expect(cfg.model).toBe(AI_PRESETS[0].models[0]);
    expect(cfg.apiKey).toBe('');
  });

  it('toPublicConfig 只给掩码不回原文', async () => {
    await updateAiConfig({ apiKey: 'sk-secret-9876' });
    const pub = toPublicConfig(await readAiConfig());
    expect(pub.hasKey).toBe(true);
    expect(pub.apiKeyMask).toBe('••••9876');
    expect(JSON.stringify(pub)).not.toContain('sk-secret');
  });
});

describe('chatEndpoint 端点归一', () => {
  it('自动补 /chat/completions;容忍尾斜杠与已带完整路径', () => {
    expect(chatEndpoint('https://a.com/v1')).toBe('https://a.com/v1/chat/completions');
    expect(chatEndpoint('https://a.com/v1/')).toBe('https://a.com/v1/chat/completions');
    expect(chatEndpoint('https://a.com/v1/chat/completions')).toBe('https://a.com/v1/chat/completions');
  });
});

describe('parseAiRecommendations 输出解析', () => {
  it('标准 JSON 对象', () => {
    const out = parseAiRecommendations('{"recommendations":[{"id":"local:a","reason":"理由"}]}');
    expect(out).toEqual([{ id: 'local:a', reason: '理由' }]);
  });

  it('容忍 ```json 围栏与前后解释文字', () => {
    const content = '好的,推荐如下:\n```json\n{"recommendations":[{"id":"local:a","reason":"r"}]}\n```\n以上。';
    expect(parseAiRecommendations(content)).toEqual([{ id: 'local:a', reason: 'r' }]);
  });

  it('容忍裸数组与 skills/items 键', () => {
    expect(parseAiRecommendations('[{"id":"x"}]')).toEqual([{ id: 'x', reason: '' }]);
    expect(parseAiRecommendations('{"skills":[{"id":"y","reason":"z"}]}')).toEqual([{ id: 'y', reason: 'z' }]);
  });

  it('垃圾输出/缺 id 条目 → 过滤或空数组', () => {
    expect(parseAiRecommendations('完全不是 JSON')).toEqual([]);
    expect(parseAiRecommendations('{"recommendations":[{"reason":"没id"},123,null]}')).toEqual([]);
  });
});

describe('aiRecommendSkills(网络层 mock)', () => {
  it('未配置 apiKey:降级 message,不发请求', async () => {
    const spy = mockAiFetch('{}');
    const r = await aiRecommendSkills({ requirement: '做个后台', fetchImpl: spy });
    expect(r.items).toEqual([]);
    expect(r.message).toContain('未配置');
    expect(spy).not.toHaveBeenCalled();
  });

  it('技能库为空:降级 message,不发请求', async () => {
    await updateAiConfig({ apiKey: 'sk-x' });
    const spy = mockAiFetch('{}');
    const r = await aiRecommendSkills({ requirement: '做个后台', fetchImpl: spy });
    expect(r.message).toContain('技能库为空');
    expect(spy).not.toHaveBeenCalled();
  });

  it('正常路径:映射库内条目、丢弃幻觉 id、按端点与密钥发请求', async () => {
    await seedSkills();
    await updateAiConfig({ baseUrl: 'https://relay.example.com/v1', model: 'm1', apiKey: 'sk-k' });
    const capture: { url?: unknown; body?: any; headers?: any } = {};
    const content = JSON.stringify({
      recommendations: [
        { id: 'local:review', reason: '需求含代码审查' },
        { id: 'local:ghost', reason: '幻觉 id' },
        { id: 'local:review', reason: '重复 id' },
        { id: 'local:test', reason: '' },
      ],
    });
    const r = await aiRecommendSkills({ requirement: 'React 后台,要代码审查', projectName: 'admin', fetchImpl: mockAiFetch(content, capture) });
    expect(r.message).toBeUndefined();
    expect(r.model).toBe('m1');
    expect(r.items.map((i) => i.id)).toEqual(['local:review', 'local:test']);
    expect(r.items[0].name).toBe('code-review');
    expect(r.items[0].reason).toBe('需求含代码审查');
    // 请求细节:归一端点 + Bearer + 模型名 + 需求进了 user 消息
    expect(capture.url).toBe('https://relay.example.com/v1/chat/completions');
    expect(capture.headers.Authorization).toBe('Bearer sk-k');
    expect(capture.body.model).toBe('m1');
    expect(capture.body.messages[1].content).toContain('React 后台');
    expect(capture.body.messages[1].content).toContain('local:review');
  });

  it('HTTP 非 200 与网络异常都降级为 message,不抛异常', async () => {
    await seedSkills();
    await updateAiConfig({ apiKey: 'sk-k' });
    const bad = (async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'invalid key' })) as unknown as typeof fetch;
    const r1 = await aiRecommendSkills({ requirement: 'x', fetchImpl: bad });
    expect(r1.items).toEqual([]);
    expect(r1.message).toContain('401');
    const boom = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const r2 = await aiRecommendSkills({ requirement: 'x', fetchImpl: boom });
    expect(r2.message).toContain('降级');
  });

  it('模型输出无法解析 → 空结果 + 提示 message', async () => {
    await seedSkills();
    await updateAiConfig({ apiKey: 'sk-k' });
    const r = await aiRecommendSkills({ requirement: 'x', fetchImpl: mockAiFetch('随便聊聊') });
    expect(r.items).toEqual([]);
    expect(r.message).toContain('没有给出');
  });
});

describe('GitHub 联网推荐(关键词搜索 agent-skills 仓库;与本地推荐成败隔离)', () => {
  const ghRepo = (full_name: string, stars: number) => ({
    full_name,
    name: full_name.split('/')[1],
    html_url: `https://github.com/${full_name}`,
    stargazers_count: stars,
    description: `desc of ${full_name}`,
  });

  it('模型给 githubKeywords:按 topic:agent-skills 搜索、排除已入库、去重、按 star 降序', async () => {
    await seedSkills();
    // 已入库的 github 仓库应被排除
    await upsertSkill({ id: 'o/in-lib:x', name: 'x', description: 'd', source: { type: 'github', uri: 'https://github.com/o/in-lib' }, tags: [], installedAt: new Date().toISOString() });
    await updateAiConfig({ apiKey: 'sk-k' });
    const capture: { ghQueries?: string[] } = {};
    const content = JSON.stringify({
      recommendations: [{ id: 'local:review', reason: 'r' }],
      githubKeywords: ['React'],
    });
    const ghItems = [ghRepo('a/low', 100), ghRepo('o/in-lib', 500), ghRepo('b/high', 9000), ghRepo('b/high', 9000)];
    const r = await aiRecommendSkills({ requirement: '做个后台', fetchImpl: mockAiFetch(content, capture, ghItems) });
    expect(r.items.map((i) => i.id)).toEqual(['local:review']);
    expect(capture.ghQueries).toHaveLength(1);
    expect(capture.ghQueries![0]).toContain('topic:agent-skills react'); // 关键词小写化 + topic 限定
    expect(r.github.map((g) => g.repo)).toEqual(['b/high', 'a/low']); // 排除已入库 + 去重 + 按 star 降序
    expect(r.github[0]).toMatchObject({ url: 'https://github.com/b/high', keyword: 'react' });
    expect(r.message).toBeUndefined();
    expect(r.githubMessage).toBeUndefined();
  });

  it('模型没给关键词:用需求里的英文词兜底(中文词不进 GitHub 搜索)', async () => {
    await seedSkills();
    await updateAiConfig({ apiKey: 'sk-k' });
    const capture: { ghQueries?: string[] } = {};
    const content = JSON.stringify({ recommendations: [] });
    const r = await aiRecommendSkills({ requirement: '做一个 react admin 后台', fetchImpl: mockAiFetch(content, capture, [ghRepo('a/x', 10)]) });
    expect(capture.ghQueries!.some((q) => q.includes('react'))).toBe(true);
    expect(capture.ghQueries!.some((q) => q.includes('admin'))).toBe(true);
    expect(r.github.map((g) => g.repo)).toEqual(['a/x']);
  });

  it('GitHub 限流/断网:本地推荐保留,githubMessage 说明,互不影响', async () => {
    await seedSkills();
    await updateAiConfig({ apiKey: 'sk-k' });
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('api.github.com')) {
        return { ok: false, status: 403, json: async () => ({}), text: async () => 'rate limited' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ recommendations: [{ id: 'local:test', reason: 'r' }], githubKeywords: ['docker'] }) } }] }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const r = await aiRecommendSkills({ requirement: 'x', fetchImpl });
    expect(r.items.map((i) => i.id)).toEqual(['local:test']);
    expect(r.github).toEqual([]);
    expect(r.githubMessage).toContain('403');
    expect(r.message).toBeUndefined();
  });

  it('技能库为空:跳过模型调用,仍返回 GitHub 联网推荐', async () => {
    await updateAiConfig({ apiKey: 'sk-k' });
    const capture: { url?: unknown; ghQueries?: string[] } = {};
    const r = await aiRecommendSkills({ requirement: 'docker 部署', fetchImpl: mockAiFetch('{}', capture, [ghRepo('d/compose', 100)]) });
    expect(r.items).toEqual([]);
    expect(r.message).toContain('技能库为空');
    expect(capture.url).toBeUndefined(); // 没发 chat 请求
    expect(r.github.map((g) => g.repo)).toEqual(['d/compose']);
  });
});

describe('联网关键词解析与兜底', () => {
  it('parseAiGithubKeywords:小写化、去非法词、去重、最多 3 个;非对象输出 → 空', () => {
    expect(parseAiGithubKeywords('{"githubKeywords":["React","docker","a","bad word!","react","' + 'x'.repeat(50) + '"]}')).toEqual(['react', 'docker']);
    expect(parseAiGithubKeywords('[{"id":"x"}]')).toEqual([]);
    expect(parseAiGithubKeywords('不是 JSON')).toEqual([]);
    expect(parseAiGithubKeywords('{"recommendations":[]}')).toEqual([]);
  });

  it('fallbackGithubKeywords:取需求里的英文词(≥3 字符),最多 2 个', () => {
    expect(fallbackGithubKeywords('做一个 React + TS 的后台')).toEqual(['react']);
    expect(fallbackGithubKeywords('纯中文需求')).toEqual([]);
    expect(fallbackGithubKeywords('k8s docker nginx')).toEqual(['k8s', 'docker']);
  });
});

describe('testAiConnection', () => {
  it('走与推荐相同的 chat 路径;成功返回 ok', async () => {
    await updateAiConfig({ model: 'm9', apiKey: 'sk-k' });
    const capture: { url?: unknown; body?: any } = {};
    const r = await testAiConnection({}, mockAiFetch('pong', capture));
    expect(r.ok).toBe(true);
    expect(r.message).toContain('m9');
    expect(capture.url).toBe(`${AI_PRESETS[0].baseUrl}/chat/completions`);
    expect(capture.body.max_tokens).toBe(1);
  });

  it('overrides 优先于已存配置(保存前先测)', async () => {
    const capture: { url?: unknown; body?: any; headers?: any } = {};
    const r = await testAiConnection(
      { baseUrl: 'https://relay.example.com', model: 'rm', apiKey: 'sk-new' },
      mockAiFetch('pong', capture),
    );
    expect(r.ok).toBe(true);
    expect(capture.url).toBe('https://relay.example.com/chat/completions');
    expect(capture.headers.Authorization).toBe('Bearer sk-new');
  });

  it('未配置 key → ok:false,不发请求', async () => {
    const spy = mockAiFetch('pong');
    const r = await testAiConnection({}, spy);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未配置');
    expect(spy).not.toHaveBeenCalled();
  });
});
