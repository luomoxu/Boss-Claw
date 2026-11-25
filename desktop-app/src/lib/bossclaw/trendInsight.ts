// 招聘趋势 AI 解读（按需生成 + 本地缓存）
// ---------------------------------------------------------------------------
// 输入 = trendAggregate 的聚合结果 + 候选人画像；输出 = 3–5 条带指标的行动建议。
// 缓存：cachedCallModel 的 key 含「模型 + 完整 messages」，筛选条件或聚合数据变化会自动
// 生成新 key；同一天重复点击不会重复计费（scope='trend-insight'，TTL 24h）。
//
// 失败降级：未配置 AI / 调用失败 → 返回错误，页面继续展示本地规则结论（trendAggregate.insights）。
import { cachedCallModel } from './llm';
import { BOSS_SKILLS, reloadSkills, skillInstructionsFor } from './skills';
import { buildCandidateBrief } from './titleScreen';
import type { AppConfig, Profile } from './types';
import type { TrendSnapshot } from './trendAggregate';

const FALLBACK_RULES = BOSS_SKILLS.find((s) => s.id === 'trend-insight')?.instructions || '';

const TASK_PROMPT = `你是求职市场分析助手。给你一份本地采集事件库的聚合结果和候选人画像，请输出 3–5 条可执行的求职策略结论。

【输出格式】纯文本，每条一行，以「- 」开头；每条 1–2 句，先引用一个输入里的具体指标，再给行动建议。
不要输出 JSON、标题、总起段或总结段。

【硬约束】
1. 样本不足（total < 20 或 activeDays < 7）时只输出「样本不足，暂不判断」及积累数据的建议。
2. 异常波动先提示「可能是采集覆盖变化」，不要把采集频率变化说成市场变化。
3. 只引用输入中出现的数字；不编造公司、薪资、趋势。
4. 不做薪资承诺、不预测录用概率；漏斗结论要指出流失最大的步骤与可调整的筛选条件。`;

function compactPayload(snapshot: TrendSnapshot) {
  const s = snapshot;
  return {
    filters: s.filters,
    range: s.rangeLabel,
    basis: s.filters.basis === 'publish' ? '发布时间（缺失回退首次采集）' : '采集时间',
    summary: s.summary,
    coverage: s.coverage,
    directions: s.directions.slice(0, 6).map((d) => ({ name: d.name, count: d.count, share: Number(d.share.toFixed(3)), medianSalaryK: d.medianSalary })),
    levels: s.levels.slice(0, 6).map((d) => ({ name: d.name, count: d.count, medianSalaryK: d.medianSalary })),
    techTags: s.techTags.slice(0, 10).map((d) => ({ name: d.name, count: d.count })),
    teamSizes: s.teamSizes.slice(0, 5).map((d) => ({ name: d.name, count: d.count })),
    hrActivity: s.hrActivity.slice(0, 6).map((d) => ({ name: d.name, count: d.count })),
    funnel: s.funnel.map((f) => ({ step: f.label, value: f.value, ofTotal: Number(f.ofTotal.toFixed(3)), lostFromPrev: f.lostFromPrev })),
    topExcludeReasons: s.reasons.slice(0, 6).map((r) => ({ reason: r.label, count: r.count })),
    hotJobs: s.hotJobs.slice(0, 5),
    // 趋势点只给按周压缩的摘要，避免 365 条日数据灌爆上下文
    weeklyTrend: compressWeekly(s.points),
    localRuleInsights: s.insights.map((i) => i.title),
  };
}

function compressWeekly(points: TrendSnapshot['points']) {
  const out: { week: string; newCount: number; activeCount: number; salaryP50: number | null }[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const chunk = points.slice(i, i + 7);
    const has = chunk.some((p) => p.newCount != null);
    if (!has) continue;
    const medians = chunk.map((p) => p.salaryP50).filter((v): v is number => v != null).sort((a, b) => a - b);
    out.push({
      week: `${chunk[0].date}~${chunk[chunk.length - 1].date}`,
      newCount: chunk.reduce((sum, p) => sum + (p.newCount || 0), 0),
      activeCount: chunk.reduce((sum, p) => sum + (p.activeCount || 0), 0),
      salaryP50: medians.length ? medians[Math.floor(medians.length / 2)] : null,
    });
  }
  return out;
}

export interface TrendInsightResult {
  ok: boolean;
  text?: string;
  error?: string;
}

function cleanBullets(raw: string): string {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^```/.test(line))
    .slice(0, 8)
    .join('\n')
    .slice(0, 4000);
}

export async function generateTrendInsight(
  snapshot: TrendSnapshot,
  profile: Profile | null,
  config: AppConfig
): Promise<TrendInsightResult> {
  try {
    let skillText = '';
    try {
      // 与 titleScreen / analyzeJob 同一语义：每次生成都从磁盘重读技能，改完即时生效
      await reloadSkills();
      skillText = await skillInstructionsFor('trend-insight');
    } catch {
      skillText = '';
    }
    const rules = skillText || FALLBACK_RULES;
    const candidate = buildCandidateBrief(profile);
    const messages = [
      {
        role: 'system' as const,
        content: `${TASK_PROMPT}\n\n【分析框架 / 筛选口径】\n${rules}`,
      },
      {
        role: 'user' as const,
        content: [
          candidate ? `【候选人背景】\n${candidate}` : '【候选人背景】未提供（只做市场层面结论）',
          `【聚合数据】\n${JSON.stringify(compactPayload(snapshot))}`,
        ].join('\n\n'),
      },
    ];
    const result = await cachedCallModel(
      messages,
      config.model,
      { jsonMode: false, temperature: 0.3, maxTokens: 1000, purpose: '招聘趋势解读' },
      { scope: 'trend-insight' }
    );
    const text = cleanBullets(typeof result === 'string' ? result : String(result?.content || result || ''));
    if (!text) return { ok: false, error: 'AI 返回为空' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
