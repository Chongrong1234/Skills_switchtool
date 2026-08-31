/**
 * AI 推荐:用 OpenAI 兼容的 chat/completions 接口,让模型读本地中央技能库,
 * 结合用户输入的开发需求,给出初步技能推荐(新建项目时的选品起点)。
 *
 * 配置存 ai.json(baseUrl / model / apiKey,字段级容错读、原子写);
 * baseUrl 可以是官方端点也可以是任何 OpenAI 兼容中转站;apiKey 明文存于本机
 * 数据目录(服务仅监听 127.0.0.1),GET 接口只回掩码不回原文。
 * 与 recommend.ts 同一约定:任何网络/解析失败都降级为 { items: [], message },绝不抛异常
 * (配置校验错误除外——那是用户输入问题,抛 AiError 由上层映射 400)。
 */
import { aiFile } from './paths.js';
import { atomicWriteJson, readJsonSafe, readRegistry } from './registry.js';

export class AiError extends Error {}

export interface AiConfig {
  baseUrl: string; // OpenAI 兼容端点(可带可不带 /v1,自动归一)
  model: string;   // 模型名
  apiKey: string;  // 明文存本机;空串 = 未配置
}

/** 基础模型选择(官方端点);「中转站」场景直接改 baseUrl/model 即可,不限于这些预设 */
export interface AiPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
}

export const AI_PRESETS: AiPreset[] = [
  { id: 'kimi', label: 'Kimi(Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'] },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4'] },
];

const DEFAULT_CONFIG: AiConfig = {
  baseUrl: AI_PRESETS[0].baseUrl,
  model: AI_PRESETS[0].models[0],
  apiKey: '',
};

/** 单次推荐的技能上限(也是给模型的硬约束) */
export const MAX_AI_RECOMMENDATIONS = 8;

/** AI 请求超时(默认 60s,SSW_AI_TIMEOUT_MS 覆盖,与 git 超时的环境变量约定一致) */
function aiTimeoutMs(): number {
  const v = Number(process.env.SSW_AI_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

export async function readAiConfig(): Promise<AiConfig> {
  const data = await readJsonSafe<Partial<AiConfig>>(aiFile(), {});
  // 字段级容错:ai.json 是用户可手改的状态区,类型不对就回落默认而不是崩溃
  return {
    baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? data.baseUrl : DEFAULT_CONFIG.baseUrl,
    model: typeof data.model === 'string' && data.model ? data.model : DEFAULT_CONFIG.model,
    apiKey: typeof data.apiKey === 'string' ? data.apiKey : '',
  };
}

/**
 * 更新配置:字段 undefined = 保持不变;apiKey 传空串 = 显式清除。
 * baseUrl 必须是 http(s) URL;model 不能为空。
 */
export async function updateAiConfig(patch: Partial<AiConfig>): Promise<AiConfig> {
  const cur = await readAiConfig();
  const next: AiConfig = { ...cur };
  if (patch.baseUrl !== undefined) {
    const u = patch.baseUrl.trim();
    if (!/^https?:\/\/.+/.test(u)) throw new AiError('baseUrl 必须是 http(s) URL(官方端点或中转站地址)');
    next.baseUrl = u;
  }
  if (patch.model !== undefined) {
    const m = patch.model.trim();
    if (!m) throw new AiError('model 不能为空');
    next.model = m;
  }
  if (patch.apiKey !== undefined) next.apiKey = patch.apiKey.trim();
  await atomicWriteJson(aiFile(), next);
  return next;
}

/** 对外展示用的配置:不回 apiKey 原文,只给掩码与 hasKey */
export function toPublicConfig(cfg: AiConfig): { baseUrl: string; model: string; hasKey: boolean; apiKeyMask: string } {
  const tail = cfg.apiKey.length >= 4 ? cfg.apiKey.slice(-4) : '';
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: cfg.apiKey.length > 0,
    apiKeyMask: cfg.apiKey ? `••••${tail}` : '',
  };
}

/** 端点归一:容忍用户粘贴到 /v1、/v1/ 甚至完整 /chat/completions */
export function chatEndpoint(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, '');
  if (u.endsWith('/chat/completions')) return u;
  return `${u}/chat/completions`;
}

type FetchLike = typeof fetch;

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** 调一次 chat/completions(抽出来供 recommend/test 共用;失败抛错由调用方降级) */
async function chatCompletions(cfg: AiConfig, messages: ChatMessage[], maxTokens: number, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(chatEndpoint(cfg.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    // 不传 temperature:部分模型(如 kimi-k2 系)只允许 temperature=1,显式传值会被 400 拒绝;
    // 省略时各家用模型自身默认值,兼容性最好,对推荐任务足够稳定
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(aiTimeoutMs()),
  });
  if (!res.ok) {
    // 中转站/官方的错误体格式不一,截一段原文帮助定位(401/404/模型名错都在这里体现)
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`AI 接口返回 ${res.status}${text ? `: ${text}` : ''}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI 接口返回缺少 choices[0].message.content');
  return content;
}

/**
 * 测试连接:走与推荐完全相同的 chat/completions 路径(max_tokens=1 的最小开销 ping),
 * 这样"测试通过 ⇒ 推荐可用"。overrides 让用户保存前先测(未填字段回落到已存配置)。
 */
export async function testAiConnection(
  overrides: Partial<AiConfig> = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; message: string }> {
  const cfg = { ...(await readAiConfig()) };
  if (overrides.baseUrl !== undefined && overrides.baseUrl.trim()) cfg.baseUrl = overrides.baseUrl.trim();
  if (overrides.model !== undefined && overrides.model.trim()) cfg.model = overrides.model.trim();
  if (overrides.apiKey !== undefined && overrides.apiKey.trim()) cfg.apiKey = overrides.apiKey.trim();
  if (!cfg.apiKey) return { ok: false, message: '未配置 API Key' };
  try {
    await chatCompletions(cfg, [{ role: 'user', content: 'ping' }], 1, fetchImpl);
    return { ok: true, message: `连接成功(${cfg.model})` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 解析模型输出为 {id, reason} 列表:容忍模型把 JSON 包在 ```json 围栏或前后解释文字里,
 * 也容忍顶层是数组或 {recommendations|skills|items: [...]}。
 */
export function parseAiRecommendations(content: string): { id: string; reason: string }[] {
  const objStart = content.indexOf('{');
  const arrStart = content.indexOf('[');
  let parsed: unknown = null;
  // 谁先出现先试谁:裸数组 [{"id":...}] 里也含 '{',不能无条件对象优先(会吃掉内部对象)
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    try {
      parsed = JSON.parse(content.slice(objStart, content.lastIndexOf('}') + 1));
    } catch {
      /* 落到数组尝试 */
    }
  }
  if (parsed === null && arrStart >= 0) {
    try {
      parsed = JSON.parse(content.slice(arrStart, content.lastIndexOf(']') + 1));
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? ((parsed as Record<string, unknown>).recommendations ??
         (parsed as Record<string, unknown>).skills ??
         (parsed as Record<string, unknown>).items)
      : null;
  if (!Array.isArray(list)) return [];
  const out: { id: string; reason: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as Record<string, unknown>).id;
    const reason = (item as Record<string, unknown>).reason;
    if (typeof id === 'string' && id) {
      out.push({ id, reason: typeof reason === 'string' ? reason : '' });
    }
  }
  return out;
}

export interface AiRecommendedSkill {
  id: string;
  name: string;
  description: string;
  reason: string; // 模型给出的一句推荐理由
  stars?: number;    // 仓库 star 数(热度展示)
  useCount?: number; // 用户历史使用次数(热度展示)
}

export interface AiRecommendResult {
  items: AiRecommendedSkill[];
  message?: string; // 降级说明(未配置/库为空/网络失败/无结果)
  model?: string;   // 实际使用的模型(便于前端展示"由 X 生成")
}

/**
 * AI 推荐技能:把中央库的 id/name/description/tags 喂给模型,按需求挑最相关的技能。
 * 幻觉 id(不在库中的)直接丢弃;任何失败降级为 { items: [], message },不抛异常。
 */
export async function aiRecommendSkills(
  input: { requirement: string; projectName?: string; fetchImpl?: FetchLike },
): Promise<AiRecommendResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const requirement = input.requirement.trim();
    if (!requirement) return { items: [], message: '请先用一两句话描述开发需求' };

    const cfg = await readAiConfig();
    if (!cfg.apiKey) {
      return { items: [], message: '未配置 AI:请在设置(或 ssw ai config)中填 API Key,可换 baseUrl 接中转站' };
    }

    const skills = await readRegistry();
    if (!skills.length) {
      return { items: [], message: '技能库为空:先添加一些 skill,AI 才有可推荐的内容' };
    }

    // 只喂必要字段控制 token;stars/uses 作为相关度相近时的 tie-break(更常用更可靠)
    const catalog = skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      stars: s.stars ?? 0,
      uses: s.useCount ?? 0,
    }));
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是 Agent Skills 推荐助手。根据用户的开发需求,从给定的技能库 JSON 中挑选最有帮助的技能。' +
          `只输出 JSON:{"recommendations":[{"id":"<技能id>","reason":"<一句中文理由>"}]},不要输出任何其他内容。` +
          `id 必须原样取自技能库,最多 ${MAX_AI_RECOMMENDATIONS} 个,按相关度降序;没有合适的就返回 {"recommendations":[]}。` +
          '相关度相近时,优先 stars(社区热度)与 uses(用户历史使用次数)更高的技能。',
      },
      {
        role: 'user',
        content:
          `开发需求:${requirement}` +
          (input.projectName ? `\n项目名:${input.projectName}` : '') +
          `\n技能库:\n${JSON.stringify(catalog)}`,
      },
    ];
    const content = await chatCompletions(cfg, messages, 1024, fetchImpl);

    const picked = parseAiRecommendations(content);
    const byId = new Map(skills.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const items: AiRecommendedSkill[] = [];
    for (const p of picked) {
      const entry = byId.get(p.id);
      if (!entry || seen.has(p.id)) continue; // 幻觉 id / 重复 id 丢弃
      seen.add(p.id);
      items.push({ id: entry.id, name: entry.name, description: entry.description, reason: p.reason, stars: entry.stars, useCount: entry.useCount });
      if (items.length >= MAX_AI_RECOMMENDATIONS) break;
    }
    return {
      items,
      model: cfg.model,
      message: items.length === 0 ? 'AI 没有给出匹配的推荐(可换需求描述重试)' : undefined,
    };
  } catch (err) {
    // 断网/超时/解析失败:与 recommend.ts 同约定,降级返回空数组 + 说明
    return {
      items: [],
      message: `AI 推荐不可用(已降级): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
