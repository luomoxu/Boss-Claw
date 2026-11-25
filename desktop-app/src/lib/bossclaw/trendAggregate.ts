// 招聘趋势聚合（本地、纯函数）
// ---------------------------------------------------------------------------
// 输入：采集事件库（collectEvents.ts 读出的 CollectEvent[]）+ pending（只为把「已投递」并进漏斗）。
// 输出：趋势页需要的全部指标与本地规则结论（AI 解读另见 trendInsight.ts）。
//
// 口径（用户已确认）：
//   - 时间轴日粒度，默认 90 天，可切 30 天 / 全部（最多 365 天，事件库保留上限）。
//   - 供给双线：「新发现」按发布时间（缺失回退首次采集时间），可切换为采集时间；
//     「本期在架」固定按最后扫到时间，二者都是按 jobId 去重后的岗位数。
//   - 薪资只看月薪基数（P25 / P50 / P75），样本量 < 3 的日期留空，不做插值猜数。
//   - 缺失采集的日期留空（折线断开），避免把「没采集」画成「市场归零」。
//   - 方向：优先用采集时的投递方向，其次用投递方向名称/关键词匹配标题，最后归「未归属」。
import type { DirectionPlan, PendingItem } from './types';
import { normalizeJobId, type CollectEvent } from './collectEvents';

export type TrendRangeKey = '30d' | '90d' | 'all';
export type TrendBasis = 'publish' | 'collect';
export type TrendPlatformFilter = 'all' | 'boss' | 'liepin';

export interface TrendFilters {
  platform: TrendPlatformFilter;
  city: string;
  direction: string;
  range: TrendRangeKey;
  basis: TrendBasis;
}

export interface TrendPoint {
  date: string;
  label: string;
  /** 当日新发现（按所选时间口径）；null = 当日无采集覆盖且无发布数据 */
  newCount: number | null;
  /** 当日仍在架（最后扫到） */
  activeCount: number | null;
  companyCount: number | null;
  salaryP25: number | null;
  salaryP50: number | null;
  salaryP75: number | null;
  salarySamples: number;
}

export interface TrendRankRow {
  name: string;
  count: number;
  share: number;
  medianSalary: number | null;
}

export interface TrendFunnelStep {
  key: string;
  label: string;
  value: number;
  ofTotal: number;
  lostFromPrev: number;
}

export interface TrendReasonRow {
  name: string;
  label: string;
  count: number;
}

export interface TrendInsightCard {
  tone: 'info' | 'good' | 'warn';
  title: string;
  body: string;
}

export interface TrendCoverage {
  /** 有采集覆盖的天数 */
  activeDays: number;
  /** 时间轴总天数 */
  spanDays: number;
  /** 有发布时间的事件占比 */
  postedCoverage: number;
  /** 有可解析月薪的事件占比 */
  salaryCoverage: number;
  firstSeen: number;
  lastSeen: number;
}

export interface TrendSnapshot {
  filters: TrendFilters;
  rangeStart: number;
  rangeEnd: number;
  rangeLabel: string;
  events: CollectEvent[];
  points: TrendPoint[];
  summary: {
    total: number;
    newInRange: number;
    companies: number;
    multiHrJobs: number;
    repeatRate: number;
    newLastPeriod: number;
    newPrevPeriod: number;
    salaryMedian: number | null;
    salaryP25: number | null;
    salaryP75: number | null;
  };
  coverage: TrendCoverage;
  directions: TrendRankRow[];
  levels: TrendRankRow[];
  techTags: TrendRankRow[];
  teamSizes: TrendRankRow[];
  hrActivity: TrendRankRow[];
  hotJobs: { title: string; company: string; jobCount: number; scanCount: number; city: string }[];
  funnel: TrendFunnelStep[];
  reasons: TrendReasonRow[];
  insights: TrendInsightCard[];
}

export const TREND_RANGES: { key: TrendRangeKey; label: string; days: number }[] = [
  { key: '30d', label: '近 30 天', days: 30 },
  { key: '90d', label: '近 90 天', days: 90 },
  { key: 'all', label: '全部（≤365 天）', days: 365 },
];

export const TREND_BASIS_OPTIONS: { value: TrendBasis; label: string }[] = [
  { value: 'publish', label: '发布时间（缺失回退采集）' },
  { value: 'collect', label: '采集时间' },
];

export const DEFAULT_TREND_FILTERS: TrendFilters = {
  platform: 'all',
  city: '',
  direction: '',
  range: '90d',
  basis: 'publish',
};

const DAY_MS = 86400000;
const MAX_DAYS = 365;

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const dayStart = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const shortLabel = (key: string) => key.slice(5).replace('-', '/');

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const v = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  return Math.round(v * 10) / 10;
}

function medianOf(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** 频次排行（带中位薪资与占比） */
function rankByName(
  entries: { name: string; salary: number | null }[],
  total: number,
  limit = 8
): TrendRankRow[] {
  const map = new Map<string, { count: number; salaries: number[] }>();
  for (const e of entries) {
    const name = e.name || '未知';
    const cur = map.get(name) || { count: 0, salaries: [] };
    cur.count += 1;
    if (e.salary != null) cur.salaries.push(e.salary);
    map.set(name, cur);
  }
  return Array.from(map.entries())
    .map(([name, v]) => ({
      name,
      count: v.count,
      share: total ? v.count / total : 0,
      medianSalary: medianOf(v.salaries),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function salaryMid(ev: CollectEvent): number | null {
  if (ev.salaryLowK == null || ev.salaryHighK == null) return null;
  const mid = (ev.salaryLowK + ev.salaryHighK) / 2;
  return Number.isFinite(mid) && mid > 0 ? Math.round(mid * 10) / 10 : null;
}

/** 事件方向：采集方向 > 标题匹配投递方向名称/关键词 > 未归属 */
export function resolveEventDirection(ev: CollectEvent, plan: DirectionPlan | null | undefined): string {
  if (ev.directionName && ev.directionName !== '采集') return ev.directionName;
  const title = ev.title || '';
  const items = plan?.items?.filter((d) => d.enabled !== false) || [];
  for (const d of items) {
    const name = String(d.name || '').trim();
    if (name && name.length >= 2 && title.includes(name)) return name;
  }
  for (const d of items) {
    const keywords = (d.keywords || []).map((k) => String(k || '').trim()).filter((k) => k.length >= 2);
    if (keywords.some((k) => title.includes(k))) return d.name;
  }
  return '未归属';
}

function teamBucket(raw: string): string {
  const n = Number(String(raw || '').replace(/[^\d]/g, ''));
  if (!n) return '未披露';
  if (n <= 10) return '1-10 人';
  if (n <= 30) return '11-30 人';
  if (n <= 100) return '31-100 人';
  return '100 人以上';
}

const HR_BUCKET_LABEL: Record<number, string> = {
  7: '在线',
  6: '刚刚活跃',
  5: '今日活跃',
  4: '3 日内活跃',
  3: '本周活跃',
  2: '本月活跃',
  1: '更早活跃',
  0: '未知',
};

const PREFILTER_LABEL: Record<string, string> = {
  seen: '已扫描过',
  queue: '已在队列',
  location: '城市反选',
  company: '公司/招聘方黑名单',
  'jd-keyword': '关键词排除',
  salary: '薪资低于底线',
  'salary-cap': '底薪超上限',
  hr: 'HR 活跃度不足',
  headhunter: '猎头岗位',
  contacted: '已沟通',
};

function reasonLabel(excludeStage: string, reason: string): string {
  const s = String(excludeStage || '');
  if (s.startsWith('prefilter:')) {
    const k = s.slice('prefilter:'.length);
    return PREFILTER_LABEL[k] || '列表预筛';
  }
  if (s === 'title') return 'AI 标题筛';
  if (s === 'reject') return 'JD 评估不推荐';
  if (s === 'below-queue-score') return '未达入队分';
  if (s === 'expiry') return '岗位已过期';
  if (s === 'interview') return '面试方式不符';
  if (s === 'headhunter') return '猎头岗位';
  if (s === 'location') return '城市反选';
  if (s === 'company') return '公司黑名单';
  if (s === 'jd-keyword') return '关键词排除';
  if (s === 'hr') return 'HR 活跃度不足';
  return reason ? String(reason).slice(0, 24) : '其他';
}

function buildPoints(
  events: CollectEvent[],
  days: string[],
  basis: TrendBasis
): TrendPoint[] {
  const newMap = new Map<string, number>();
  const activeMap = new Map<string, number>();
  const companiesByDay = new Map<string, Set<string>>();
  const salaryByDay = new Map<string, number[]>();
  const coverageDays = new Set<string>();

  for (const ev of events) {
    const activeDay = dayKey(ev.lastSeenAt);
    coverageDays.add(activeDay);
    activeMap.set(activeDay, (activeMap.get(activeDay) || 0) + 1);
    const comp = ev.company || ev.title;
    if (comp) {
      if (!companiesByDay.has(activeDay)) companiesByDay.set(activeDay, new Set());
      companiesByDay.get(activeDay)!.add(comp);
    }
    const newTs = basis === 'publish' ? ev.postedAtApprox ?? ev.firstSeenAt : ev.firstSeenAt;
    const newDay = dayKey(newTs);
    newMap.set(newDay, (newMap.get(newDay) || 0) + 1);
    const salaryDay = basis === 'publish' ? dayKey(ev.postedAtApprox ?? ev.firstSeenAt) : dayKey(ev.firstSeenAt);
    const mid = salaryMid(ev);
    if (mid != null) {
      if (!salaryByDay.has(salaryDay)) salaryByDay.set(salaryDay, []);
      salaryByDay.get(salaryDay)!.push(mid);
    }
  }

  return days.map((date) => {
    const hasCoverage = coverageDays.has(date) || newMap.has(date);
    const salaries = (salaryByDay.get(date) || []).sort((a, b) => a - b);
    const samples = salaries.length;
    return {
      date,
      label: shortLabel(date),
      newCount: hasCoverage ? newMap.get(date) || 0 : null,
      activeCount: hasCoverage ? activeMap.get(date) || 0 : null,
      companyCount: hasCoverage ? companiesByDay.get(date)?.size ?? 0 : null,
      salaryP25: samples >= 3 ? percentile(salaries, 0.25) : null,
      salaryP50: samples >= 3 ? percentile(salaries, 0.5) : null,
      salaryP75: samples >= 3 ? percentile(salaries, 0.75) : null,
      salarySamples: samples,
    };
  });
}

function buildFunnel(events: CollectEvent[], sentKeys: Set<string>): TrendFunnelStep[] {
  const total = events.length;
  const pre = events.filter((e) => e.stage === 'prefilter_excluded').length;
  const title = events.filter((e) => e.stage === 'title_excluded').length;
  const jd = events.filter((e) => e.stage === 'jd_excluded' || e.stage === 'filtered').length;
  // 漏斗只看事件阶段；pending 中已投递的岗位再并进来（事件可能停在 qualified）
  let sent = events.filter((e) => e.stage === 'sent').length;
  for (const e of events) if (sentKeys.has(e.key)) sent += 1;
  const afterPre = Math.max(0, total - pre);
  const afterTitle = Math.max(0, afterPre - title);
  const afterJd = Math.max(0, afterTitle - jd);
  const steps = [
    { key: 'scanned', label: '扫描到', value: total },
    { key: 'prefilter', label: '通过列表预筛', value: afterPre },
    { key: 'title', label: '通过 AI 标题筛', value: afterTitle },
    { key: 'jd', label: '通过 JD 评估/入队', value: afterJd },
    { key: 'sent', label: '已投递', value: Math.min(afterJd, sent) },
  ];
  return steps.map((s, i) => ({
    ...s,
    ofTotal: total ? s.value / total : 0,
    lostFromPrev: i === 0 ? 0 : Math.max(0, steps[i - 1].value - s.value),
  }));
}

function buildReasons(events: CollectEvent[]): TrendReasonRow[] {
  const map = new Map<string, number>();
  for (const ev of events) {
    if (!ev.excludeStage && ev.stage !== 'filtered') continue;
    const label = reasonLabel(ev.excludeStage, ev.reason);
    map.set(label, (map.get(label) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([label, count]) => ({ name: label, label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function buildInsights(
  snapshot: Omit<TrendSnapshot, 'insights'>
): TrendInsightCard[] {
  const out: TrendInsightCard[] = [];
  const { summary, coverage, directions, funnel, reasons, points } = snapshot;
  if (summary.total < 20 || coverage.activeDays < 7) {
    out.push({
      tone: 'warn',
      title: '样本还不足，先积累数据',
      body: `当前范围内 ${summary.total} 个岗位、${coverage.activeDays} 天有采集覆盖。建议至少积累 7 天 / 20 个岗位后再看趋势，避免把采集波动当市场变化。`,
    });
    return out;
  }
  // 1) 新发现趋势（最近 14 天 vs 前 14 天；不足 14 天则前后各半）
  const nz = points.filter((p) => p.newCount != null);
  if (nz.length >= 6) {
    const half = Math.min(14, Math.floor(nz.length / 2));
    const prev = nz.slice(-half * 2, -half).reduce((s, p) => s + (p.newCount || 0), 0);
    const last = nz.slice(-half).reduce((s, p) => s + (p.newCount || 0), 0);
    if (prev > 0 || last > 0) {
      const delta = prev > 0 ? Math.round(((last - prev) / prev) * 100) : null;
      out.push({
        tone: last >= prev ? 'good' : 'info',
        title: '供给节奏',
        body: delta == null
          ? `最近 ${half} 天新发现 ${last} 个岗位，上一周期 ${prev} 个（上周期无样本，暂不做百分比判断）。`
          : `最近 ${half} 天新发现 ${last} 个岗位，较前 ${half} 天 ${delta >= 0 ? '+' : ''}${delta}%。若期间改过关键词或采集 tab，请先排除覆盖变化。`,
      });
    }
  }
  // 2) 方向集中度
  const topDir = directions.find((d) => d.name !== '未归属');
  if (topDir && summary.total) {
    out.push({
      tone: 'info',
      title: `方向：${topDir.name}`,
      body: `占 ${Math.round(topDir.share * 100)}%（${topDir.count} 个岗位）${topDir.medianSalary != null ? `，月薪中位 ${topDir.medianSalary}K` : ''}。` +
        (topDir.share > 0.5 ? '集中度较高，可补一条相邻方向扩大样本。' : '方向分布较分散，可对比各方向漏斗再决定主投。'),
    });
  }
  // 3) 薪资
  if (summary.salaryMedian != null) {
    out.push({
      tone: 'info',
      title: '薪资区间',
      body: `月薪中位 ${summary.salaryMedian}K（P25 ${summary.salaryP25 ?? '—'}K / P75 ${summary.salaryP75 ?? '—'}K），` +
        `薪资可解析覆盖率 ${Math.round(coverage.salaryCoverage * 100)}%。覆盖率偏低时，结论只代表披露薪资的岗位。`,
    });
  }
  // 4) 漏斗最大流失（只看筛选步骤；「未投递」不是筛选条件，不能建议用户调筛选）
  const lossStep = funnel.slice(1, 4).sort((a, b) => b.lostFromPrev - a.lostFromPrev)[0];
  if (lossStep && lossStep.lostFromPrev > 0) {
    const topReason = reasons[0];
    out.push({
      tone: 'warn',
      title: `漏斗：${lossStep.label}前流失最多`,
      body: `该步流失 ${lossStep.lostFromPrev} 个岗位（占扫描量 ${Math.round((lossStep.lostFromPrev / Math.max(1, funnel[0].value)) * 100)}%）` +
        `${topReason ? `，主要原因「${topReason.label}」${topReason.count} 个` : ''}。可先检查这一步的筛选条件是否过紧。`,
    });
  }
  // 5) 多 HR / 重复招聘热度
  const hot = snapshot.hotJobs[0];
  if (hot && hot.jobCount > 1) {
    out.push({
      tone: 'good',
      title: '重复招聘信号',
      body: `「${hot.company} · ${hot.title}」在范围内出现 ${hot.jobCount} 个岗位（被扫到 ${hot.scanCount} 次），可能是多 HR 并行招聘或长期在招。可优先核对团队稳定性与岗位真实 HC。`,
    });
  }
  return out.slice(0, 5);
}

export interface BuildTrendInput {
  events: CollectEvent[];
  pending?: PendingItem[];
  directionPlan?: DirectionPlan | null;
  filters: TrendFilters;
  now?: number;
}

export function buildTrendSnapshot(input: BuildTrendInput): TrendSnapshot {
  const now = input.now ?? Date.now();
  const filters = input.filters;
  const rangeMeta = TREND_RANGES.find((r) => r.key === filters.range) || TREND_RANGES[1];
  const endDay = dayStart(now);
  let startDay = endDay - (rangeMeta.days - 1) * DAY_MS;
  if (filters.range === 'all') {
    const firsts = input.events.map((e) => Number(e.firstSeenAt) || 0).filter(Boolean);
    if (firsts.length) {
      const earliest = Math.min(...firsts);
      startDay = Math.max(dayStart(earliest), endDay - (MAX_DAYS - 1) * DAY_MS);
    }
  }
  const days: string[] = [];
  const dayCount = Math.round((endDay - startDay) / DAY_MS) + 1;
  for (let i = 0; i < dayCount; i += 1) {
    const d = new Date(startDay);
    d.setDate(d.getDate() + i);
    days.push(dayKey(d.getTime()));
  }
  const rangeStart = startDay;
  const rangeEnd = now;

  // 平台 / 城市 / 方向过滤（方向需要先解析）
  const sentKeys = new Set<string>();
  for (const p of input.pending || []) {
    if (!p?.sentAt) continue;
    const platform = p.job?.platform === 'liepin' ? 'liepin' : 'boss';
    const jid = normalizeJobId(p.job?.jobId) || String(p.job?.url || '').match(/job_detail\/([^/?#.]+)/i)?.[1] || '';
    if (jid) sentKeys.add(`${platform}:${jid.toLowerCase()}`);
  }

  const events = input.events
    .filter((ev) => ev.lastSeenAt >= rangeStart || ev.firstSeenAt >= rangeStart)
    .filter((ev) => filters.platform === 'all' || ev.platform === filters.platform)
    .filter((ev) => !filters.city || ev.city === filters.city)
    .filter((ev) => !filters.direction || resolveEventDirection(ev, input.directionPlan) === filters.direction);

  const points = buildPoints(events, days, filters.basis);
  const total = events.length;
  const companies = new Set(events.map((e) => e.company || e.title).filter(Boolean)).size;
  const salaryValues = events.map(salaryMid).filter((v): v is number => v != null).sort((a, b) => a - b);
  const newInRange = events.filter((e) => (filters.basis === 'publish' ? e.postedAtApprox ?? e.firstSeenAt : e.firstSeenAt) >= rangeStart).length;

  const coverageDays = new Set<string>();
  const daySet = new Set(days);
  const postedCount = events.filter((e) => e.postedAtApprox != null).length;
  let firstSeen = 0;
  let lastSeen = 0;
  for (const ev of events) {
    if (daySet.has(dayKey(ev.lastSeenAt))) coverageDays.add(dayKey(ev.lastSeenAt));
    const f = Number(ev.firstSeenAt) || 0;
    if (f && (!firstSeen || f < firstSeen)) firstSeen = f;
    if (Number(ev.lastSeenAt) > lastSeen) lastSeen = Number(ev.lastSeenAt);
  }

  // 多 HR 热度：同公司 + 同标题下的不同 jobId 数；scanCount 汇总
  const hotMap = new Map<string, { title: string; company: string; city: string; ids: Set<string>; scanCount: number }>();
  for (const ev of events) {
    const sig = `${ev.company || ''}|${ev.title || ''}`;
    if (!ev.title) continue;
    const cur = hotMap.get(sig) || { title: ev.title, company: ev.company, city: ev.city, ids: new Set<string>(), scanCount: 0 };
    cur.ids.add(ev.key);
    cur.scanCount += Number(ev.scanCount) || 0;
    hotMap.set(sig, cur);
  }
  const allHot = Array.from(hotMap.values())
    .map((v) => ({ title: v.title, company: v.company, city: v.city, jobCount: v.ids.size, scanCount: v.scanCount }))
    .sort((a, b) => b.jobCount - a.jobCount || b.scanCount - a.scanCount);
  const hotJobs = allHot.slice(0, 8);
  const multiHrJobs = allHot.filter((h) => h.jobCount > 1).reduce((s, h) => s + h.jobCount, 0);
  const repeatRate = total ? events.filter((e) => (e.scanCount || 0) > 1).length / total : 0;

  // 前后周期（变化卡片用；与 points 的前后各半口径一致）
  const nz = points.filter((p) => p.newCount != null);
  const half = Math.min(14, Math.floor(nz.length / 2));
  const newPrevPeriod = half ? nz.slice(-half * 2, -half).reduce((s, p) => s + (p.newCount || 0), 0) : 0;
  const newLastPeriod = half ? nz.slice(-half).reduce((s, p) => s + (p.newCount || 0), 0) : 0;

  const dirEntries = events.map((e) => ({
    name: resolveEventDirection(e, input.directionPlan),
    salary: salaryMid(e),
  }));

  const salaryP25 = percentile(salaryValues, 0.25);
  const salaryP75 = percentile(salaryValues, 0.75);

  const snapshotBase: Omit<TrendSnapshot, 'insights'> = {
    filters,
    rangeStart,
    rangeEnd,
    rangeLabel: `${days[0]} ~ ${days[days.length - 1]}`,
    events,
    points,
    summary: {
      total,
      newInRange,
      companies,
      multiHrJobs,
      repeatRate,
      newLastPeriod,
      newPrevPeriod,
      salaryMedian: medianOf(salaryValues),
      salaryP25,
      salaryP75,
    },
    coverage: {
      activeDays: coverageDays.size,
      spanDays: days.length,
      postedCoverage: total ? postedCount / total : 0,
      salaryCoverage: total ? salaryValues.length / total : 0,
      firstSeen,
      lastSeen,
    },
    directions: rankByName(dirEntries, total),
    levels: rankByName(events.map((e) => ({ name: e.level || '未知', salary: salaryMid(e) })), total),
    techTags: rankByName(
      events.flatMap((e) => (e.techTags || []).map((tag) => ({ name: tag, salary: salaryMid(e) }))),
      Math.max(1, events.reduce((s, e) => s + (e.techTags?.length || 0), 0)),
      12
    ),
    teamSizes: rankByName(events.map((e) => ({ name: teamBucket(e.teamSize), salary: salaryMid(e) })), total, 6),
    hrActivity: rankByName(events.map((e) => ({ name: hrBucketLabel(e.hrActive), salary: null })), total, 8),
    hotJobs,
    funnel: buildFunnel(events, sentKeys),
    reasons: buildReasons(events),
  };
  return { ...snapshotBase, insights: buildInsights(snapshotBase) };
}

function hrBucketLabel(hrActive: string): string {
  const s = String(hrActive || '');
  if (!s) return HR_BUCKET_LABEL[0];
  if (/(^|[^一-龥])在线([^一-龥]|$)/.test(s) || /当前在线|在线中/.test(s)) return HR_BUCKET_LABEL[7];
  if (/刚刚活跃|几分钟前/.test(s)) return HR_BUCKET_LABEL[6];
  if (/今日活跃|今天活跃/.test(s)) return HR_BUCKET_LABEL[5];
  const d = s.match(/(\d+)\s*日内活跃/);
  if (d) {
    const n = Number(d[1]);
    if (n <= 3) return HR_BUCKET_LABEL[4];
    if (n <= 7) return HR_BUCKET_LABEL[3];
    if (n <= 30) return HR_BUCKET_LABEL[2];
    return HR_BUCKET_LABEL[1];
  }
  if (/本周活跃/.test(s)) return HR_BUCKET_LABEL[3];
  if (/本月活跃/.test(s)) return HR_BUCKET_LABEL[2];
  if (/半年前活跃|数月前活跃|很久前活跃|近半年活跃/.test(s)) return HR_BUCKET_LABEL[1];
  return HR_BUCKET_LABEL[0];
}

/** 从事件集合提取筛选项（城市 / 方向），供页面下拉使用 */
export function trendFilterOptions(events: CollectEvent[], directionPlan?: DirectionPlan | null) {
  const cities = Array.from(new Set(events.map((e) => e.city).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const dirSet = new Set<string>();
  for (const e of events) dirSet.add(resolveEventDirection(e, directionPlan));
  const directions = Array.from(dirSet).sort((a, b) => {
    if (a === '未归属') return 1;
    if (b === '未归属') return -1;
    return a.localeCompare(b);
  });
  return { cities, directions };
}
