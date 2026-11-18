// 标题级职位初筛（列表页）
// ---------------------------------------------------------------------------
// 目的：列表页的卡片只有「标题 / 公司 / 薪资 / 地点 / 标签」，但很多岗位**看一眼标题就知道
// 不该投**（无人机系统总师、智驾智仓开发专家、营养医师、成衣服装供应链总监…）。这类岗位如果
// 点开详情再交给 analyzeJob，既多发一次请求（风控），又白烧一次完整 JD 评分。
//
// 做法：把一批标题交给模型做「标题层初筛」，只标出**一眼就不该投**的，拿不准的一律保留
// （宁可多开一次详情，不可误杀）。判定口径对齐 JD 筛选标准 v3.4（硬门槛 + H10 强 AI 关联岗）。
//
// 与 analyzeJob 的关系：这里只是**前置剪刀**，不做打分、不写决策。通过者在详情阶段仍会
// 走完整的 analyzeJob（原过滤 + 100 分制评分），两边结论不冲突——初筛判错的唯一代价是多开一次详情。
//
// 失败降级：AI 未配置 / 调用失败 / 返回不可解析 → **不筛标题**，直接把全部岗位交给详情阶段
// （等价改造前的行为），并在日志里明确写一条，避免用户误以为「筛选生效了但没效果」。
import { cachedCallModel } from './llm';
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

const SYSTEM_PROMPT = `你是高级技术管理岗的「标题级」职位初筛器。候选人应聘的是 CTO / 技术总监 / 研发负责人 / 技术负责人 / 架构师这一层。

【任务】输入是一批岗位的**列表页信息**（标题、公司、薪资、地点、卡片标签），没有 JD 正文。
请只标出「一眼就不该投」的岗位；拿不准的一律保留。宁可多开一次详情，不可误杀。

【排除（命中任一即排除）】
A. 技术域不对口：无人机、飞控、自动驾驶/智驾、机器人、具身智能、芯片、半导体、固件、嵌入式、硬件、PCB、射频、光学、仿真、生物医药、化工、能源工程、土木建筑、电气机械、纺织服装、医疗健康、餐饮等非软件技术域。
B. 岗位性质不对：销售、售前、实施、驻场、外包、客服、运营、测试、运维值班、技术支持、数据开发、DBA、算法、产品经理、项目经理（非技术一号位）。
C. 层级明显不对：初级、专员、助理、实习生；纯执行开发/工程师岗（如「Java 开发工程师」「软件测试工程师」），除非同时是负责人/总监/架构。
D. 强 AI 关联岗：大模型、算法、Agent 平台、AIGC 生产管线本身是核心产出（不是「用 AI 给业务提效」）。

【保留（不要排除）】CTO、技术总监、研发总监、技术负责人、研发负责人、架构师、技术经理、产研负责人、VP；以及任何看不准的。

【反例】
- 「无人机系统总师」：层级很高，但技术域不对口 → 排除。
- 「智驾智仓开发专家」：技术域不对口 → 排除。
- 「营养医师」「成衣服装供应链总监」：行业/职能完全不对口 → 排除。
- 「AI 应用架构师（Java）」：以 Java/业务架构为主，AI 只是应用层 → 保留。
- 「商旅产研总监」：交易/业务系统为主 → 保留。

【输出】只输出 JSON：{"exclude":[{"i":1,"reason":"一句话原因"}]}
- i 是输入数组里的序号（从 1 开始）。
- 没有要排除的就输出 {"exclude":[]}。
- 不要输出任何解释性文字。`;

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
  const brief = buildCandidateBrief(options.profile);
  const systemPrompt = brief ? `${SYSTEM_PROMPT}\n\n【候选人背景】\n${brief}` : SYSTEM_PROMPT;

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
        // 复用 job-analysis 缓存域：缓存 key 已包含完整 messages，不会与单岗分析互相污染；
        // 「清空岗位分析缓存」时一并清掉标题筛选结果，语义上也符合预期。
        { scope: 'job-analysis' }
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
