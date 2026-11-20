// 标题级职位初筛（列表页）
// ---------------------------------------------------------------------------
// 目的：列表页的卡片只有「标题 / 公司 / 薪资 / 地点 / 标签」，但很多岗位**看一眼标题就知道
// 不该投**（无人机系统总师、智驾智仓开发专家、营养医师、成衣服装供应链总监…）。这类岗位如果
// 点开详情再交给 analyzeJob，既多发一次请求（风控），又白烧一次完整 JD 评分。
//
// 做法：把一批标题交给模型做「标题层初筛」，只标出**一眼就不该投**的，拿不准的一律保留
// （宁可多开一次详情，不可误杀）。判定口径来自 `title-screen` 作用域技能（设置页可新建/编辑/停用），
// 软件只内置一份通用兜底——同一套技能机制也能承载用户自己的行业/职级标准，无需改代码。
//
// 与 analyzeJob 的关系：这里只是**前置剪刀**，不做打分、不写决策。通过者在详情阶段仍会
// 走完整的 analyzeJob（原过滤 + 100 分制评分），两边结论不冲突——初筛判错的唯一代价是多开一次详情。
//
// 失败降级：AI 未配置 / 调用失败 / 返回不可解析 → **不筛标题**，直接把全部岗位交给详情阶段
// （等价改造前的行为），并在日志里明确写一条，避免用户误以为「筛选生效了但没效果」。
import { cachedCallModel } from './llm';
import { BOSS_SKILLS, reloadSkills, skillInstructionsFor } from './skills';
import type { AppConfig, Profile } from './types';

export interface TitleScreenItem {
  /** 列表卡片去重键（归一化 URL），回传给宿主用于匹配 */
  key: string;
  title: string;
  company?: string;
  salary?: string;
  location?: string;
  /** 整卡文本（含行业/技能/学历标签），截断到 200 字 */
  raw?: string;
}

export interface TitleScreenOptions {
  model: AppConfig['model'];
  /** 每批条数（默认 50） */
  batchSize?: number;
  profile?: Profile | null;
  /** 中途停止（用户点「停止」） */
  shouldStop?: () => boolean;
}

export interface TitleScreenResult {
  /** key -> 排除原因 */
  excluded: Map<string, string>;
  /** 是否真的跑了 AI（false = 未配置/全部批次失败，调用方据此记录日志） */
  usedAI: boolean;
  batches: number;
  failedBatches: number;
  errors: string[];
}

const DEFAULT_BATCH_SIZE = 50;

// 软件层只固定「任务 + 输入/输出契约 + 宁多勿少」：
// 具体筛选口径属于用户配置，来自 title-screen 作用域技能（可新建/编辑/停用），
// 代码里只保留一份通用兜底口径（skills.ts 的 title-screen 内置技能），
// 不把某一位求职者的行业/职级/技术域写死进软件。
const TASK_PROMPT = `你是「列表页标题级」职位初筛器。输入是一批岗位的**列表页信息**（标题、公司、薪资、地点、卡片标签），没有 JD 正文。

【任务】按【筛选口径】只标出「一眼就不该投」的岗位；拿不准的一律保留。宁可多开一次详情，不可误杀。

【输出】只输出 JSON：{"exclude":[{"i":1,"reason":"一句话原因"}]}
- i 是输入数组里的序号（从 1 开始）。
- 没有要排除的就输出 {"exclude":[]}。
- reason 不超过 30 字，写具体原因（如「方向不符：无人机」）。
- 不要输出任何解释性文字。`;

/** 技能全部停用时的兜底口径（与内置 title-screen 技能正文一致，保证功能不丢） */
const FALLBACK_RULES = BOSS_SKILLS.find((s) => s.id === 'title-screen')?.instructions || '';

/** 从画像提炼一段「候选人锚点」，让标题筛选知道我们是谁（取不到也没关系）。 */
export function buildCandidateBrief(profile?: Profile | null): string {
  if (!profile) return '';
  const parts: string[] = [];
  const summary = String(profile.summary || '').replace(/\s+/g, ' ').trim();
  if (summary) parts.push(summary.slice(0, 300));
  const dirs = (profile.primaryDirections || [])
    .map((d) => String(d?.name || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  if (dirs.length) parts.push(`主投方向：${dirs.join('、')}`);
  const exclude = (profile.excludeDirections || []).map((d) => String(d || '').trim()).filter(Boolean).slice(0, 6);
  if (exclude.length) parts.push(`明确不考虑：${exclude.join('、')}`);
  return parts.join('\n');
}

function buildUserPayload(batch: TitleScreenItem[]): string {
  const rows = batch.map((item, idx) => ({
    i: idx + 1,
    t: String(item.title || '').slice(0, 60),
    c: String(item.company || '').slice(0, 40),
    s: String(item.salary || '').slice(0, 24),
    l: String(item.location || '').slice(0, 24),
    tags: String(item.raw || '').replace(/\s+/g, ' ').slice(0, 160),
  }));
  return JSON.stringify(rows);
}

function parseExclusions(
  raw: any,
  batch: TitleScreenItem[],
  excluded: Map<string, string>
): void {
  const list = Array.isArray(raw?.exclude) ? raw.exclude : [];
  for (const entry of list) {
    const idx = Number(entry?.i);
    if (!Number.isInteger(idx) || idx < 1 || idx > batch.length) continue;
    const reason = String(entry?.reason || '标题不符').replace(/\s+/g, ' ').slice(0, 60);
    const item = batch[idx - 1];
    if (item?.key) excluded.set(item.key, reason);
  }
}

/**
 * 批量标题筛选。按 batchSize 分批调用模型；任一批失败只影响该批（该批全部保留）。
 * 返回 excluded（key -> 原因）与 usedAI（至少一批成功时为 true）。
 */
export async function screenTitles(
  items: TitleScreenItem[],
  options: TitleScreenOptions
): Promise<TitleScreenResult> {
  const excluded = new Map<string, string>();
  const errors: string[] = [];
  const result: TitleScreenResult = { excluded, usedAI: false, batches: 0, failedBatches: 0, errors };
  if (!items.length) return result;

  const batchSize = Math.max(10, Math.min(120, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
  // 每轮重读 skills/*/SKILL.md：用户改了筛选口径即时生效（与 analyzeJob 同一语义）。
  await reloadSkills();
  const skillRules = await skillInstructionsFor('title-screen');
  const rules = skillRules
    || `\n\n【AI 技能 · 列表标题预筛（默认口径）】（由软件 skills 层兜底注入，必须遵守）\n${FALLBACK_RULES}`;
  const brief = buildCandidateBrief(options.profile);
  const systemPrompt = TASK_PROMPT + rules + (brief ? `\n\n【候选人背景】\n${brief}` : '');

  for (let start = 0; start < items.length; start += batchSize) {
    if (options.shouldStop?.()) break;
    const batch = items.slice(start, start + batchSize);
    result.batches += 1;
    try {
      const raw = await cachedCallModel(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildUserPayload(batch) },
        ],
        options.model,
        { maxTokens: 1600, temperature: 0 },
        // 独立缓存域：缓存 key 已包含完整 messages（含筛选口径），口径一改自动失效；
        // 与单岗分析分开统计，设置页清缓存时一并清空。
        { scope: 'title-screen' }
      );
      parseExclusions(raw, batch, excluded);
      result.usedAI = true;
    } catch (err: any) {
      result.failedBatches += 1;
      const msg = String(err?.message || err || '未知错误').slice(0, 120);
      errors.push(`第 ${result.batches} 批失败：${msg}`);
    }
  }
  return result;
}
