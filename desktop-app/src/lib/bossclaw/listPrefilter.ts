// 列表页确定性预筛（不点详情）
// ---------------------------------------------------------------------------
// 位置：采集「扫描阶段」拿到整页卡片之后、AI 标题筛选之前、点开详情之前。
// 作用：把**不需要 AI 也能判死**的岗位拦在详情页外——已扫描过、已在队列里、城市反选、
// 薪资越界、HR 活跃度不足、猎头、已沟通。
//
// 与 ingestJob 的关系：这里只做「省一次详情点击」的优化，ingestJob 里的原过滤全部保留
// （双重保险）。两边判定不一致时以 ingestJob / analyzeJob 为准。
//
// 与标题筛选的关系：本文件只做确定性规则；「专业对不对口」这类语义判断交给 titleScreen.ts。
import type { AppConfig, JobPlatform } from './types';
import { isLocationExcluded } from './locationFilter';
import { isCompanyExcluded } from './companyFilter';
import { isJdKeywordExcluded } from './jdKeywordFilter';
import { meetsHrActivityFilter } from './hrActivity';
import { parseSalaryRange } from './jobMatch';
import { isSeenJob, seenJobKey, type SeenMap } from './seenJobs';

/** 页内扫描回传的卡片记录（见 webview.cjs scanList） */
export interface ListCardRecord {
  key: string;
  jobId?: string;
  title: string;
  company?: string;
  salary?: string;
  location?: string;
  raw?: string;
  hrActive?: string;
  isHeadhunter?: boolean;
}

export type PrefilterReason =
  | 'seen'
  | 'queue'
  | 'location'
  | 'company'
  | 'jd-keyword'
  | 'salary'
  | 'salary-cap'
  | 'hr'
  | 'headhunter'
  | 'contacted';

export const PREFILTER_LABELS: Record<PrefilterReason, string> = {
  seen: '已扫描',
  queue: '已在队列',
  location: '城市反选',
  company: '公司/招聘方黑名单',
  'jd-keyword': '关键词排除',
  salary: '薪资低于底线',
  'salary-cap': '底薪超过上限',
  hr: 'HR 活跃度不足',
  headhunter: '猎头岗位',
  contacted: '已沟通',
};

export interface PrefilterContext {
  platform: JobPlatform;
  config: AppConfig;
  seen: SeenMap;
  /** 当前筛选规则指纹（skill 正文 + 标题筛选配置），与索引里的 rulesHash 不一致时旧记录失效 */
  rulesHash: string;
  /** 索引有效期（毫秒），0 = 不按时间淘汰 */
  seenTtlMs: number;
  /** 已在队列的岗位键（`platform:jobid`），含全部状态 */
  queueKeys: Set<string>;
}

export interface PrefilterSkip {
  card: ListCardRecord;
  reason: PrefilterReason;
  detail: string;
}

export interface PrefilterOutcome {
  pass: ListCardRecord[];
  skipped: PrefilterSkip[];
  counts: Record<PrefilterReason, number>;
}

/** 薪资上限（底薪 > 60K 直接排除，对齐 JD 筛选标准「薪资区间上下限」） */
export const SALARY_FLOOR_CAP_K = 60;

function emptyCounts(): Record<PrefilterReason, number> {
  return {
    seen: 0,
    queue: 0,
    location: 0,
    company: 0,
    'jd-keyword': 0,
    salary: 0,
    'salary-cap': 0,
    hr: 0,
    headhunter: 0,
    contacted: 0,
  };
}

/** 卡片对应的岗位号（优先卡片字段，其次从详情 URL 提取）；供「已扫描」索引用 */
export function listCardJobId(card: ListCardRecord): string {
  const direct = String(card.jobId || '').trim();
  if (direct) return direct;
  // 兜底：从卡片 key（通常是详情 URL）里取 /job_detail/{id}
  const m = String(card.key || '').match(/job_detail\/([^/?#.]+)/i);
  return m?.[1] ? String(m[1]) : '';
}

/** 单卡确定性判定：命中返回原因，否则 null */
function judgeCard(card: ListCardRecord, ctx: PrefilterContext): PrefilterSkip | null {
  const { config, platform } = ctx;
  const jobId = listCardJobId(card);

  // 1) 已在队列（任意状态）
  const key = seenJobKey(platform, jobId);
  if (key && ctx.queueKeys.has(key)) {
    return { card, reason: 'queue', detail: '该岗位已在队列中（含已忽略/已拒绝）' };
  }

  // 2) 已扫描且规则未变
  const seen = isSeenJob(ctx.seen, key, ctx.rulesHash, ctx.seenTtlMs);
  if (seen) {
    return {
      card,
      reason: 'seen',
      detail: `已于 ${new Date(Number(seen.seenAt) || 0).toLocaleDateString()} 评估过（${seen.stage === 'title' ? '标题筛选' : 'JD 分析'}）`,
    };
  }

  // 3) 城市反选
  if (isLocationExcluded(card.location, config)) {
    return { card, reason: 'location', detail: `所在地 ${card.location || ''} 命中城市反选` };
  }

  // 4) 公司 / 招聘方黑名单
  const companyHit = isCompanyExcluded({ company: card.company, recruiterName: '' }, config);
  if (companyHit.excluded) {
    return { card, reason: 'company', detail: companyHit.reason };
  }

  // 5) 「岗位描述排除关键字」在标题 / 整卡文本上命中（与 ingestJob 同口径，JD 正文阶段还会再判一次）
  const jdHit = isJdKeywordExcluded({ title: card.title, cardText: card.raw }, config);
  if (jdHit.excluded) {
    return { card, reason: 'jd-keyword', detail: jdHit.reason };
  }

  // 6) 薪资：低于最低月薪 / 底薪高于上限
  const range = parseSalaryRange(card.salary);
  if (range.valid) {
    const minMonthly = Number(config.minSalaryPerMonth || 0);
    if (minMonthly > 0 && range.low < minMonthly) {
      return { card, reason: 'salary', detail: `月薪下限 ${Math.round(range.low * 10) / 10}K < 设定最低 ${minMonthly}K` };
    }
    if (range.low > SALARY_FLOOR_CAP_K) {
      return { card, reason: 'salary-cap', detail: `底薪 ${Math.round(range.low * 10) / 10}K > ${SALARY_FLOOR_CAP_K}K` };
    }
  }

  // 7) HR 活跃度
  const hrFilter = config.hrActivityFilter || 'any';
  if (hrFilter !== 'any' && !meetsHrActivityFilter(card.hrActive, hrFilter)) {
    return { card, reason: 'hr', detail: `招聘方活跃度「${card.hrActive || '未知'}」不满足「${hrFilter}」` };
  }

  // 8) 猎头（按开关）
  if (config.excludeHeadhunters && card.isHeadhunter) {
    return { card, reason: 'headhunter', detail: '卡片标记为猎头发布' };
  }

  // 9) 已沟通 / 继续沟通（按开关）
  if (config.skipContactedJobs && /已沟通|继续沟通/.test(String(card.raw || ''))) {
    return { card, reason: 'contacted', detail: '该岗位已沟通过' };
  }

  return null;
}

export function prefilterListCards(cards: ListCardRecord[], ctx: PrefilterContext): PrefilterOutcome {
  const pass: ListCardRecord[] = [];
  const skipped: PrefilterSkip[] = [];
  const counts = emptyCounts();
  for (const card of cards) {
    const hit = judgeCard(card, ctx);
    if (hit) {
      counts[hit.reason] += 1;
      skipped.push(hit);
      continue;
    }
    pass.push(card);
  }
  return { pass, skipped, counts };
}

/** 生成可读的聚合摘要：`已扫描 12 / 已在队列 3 / 薪资 2` */
export function describePrefilterCounts(counts: Record<PrefilterReason, number>): string {
  const parts = (Object.keys(counts) as PrefilterReason[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${PREFILTER_LABELS[k]} ${counts[k]}`);
  return parts.join(' / ');
}

/** 供宿主构造队列键集合：把 pending（任意状态）转成 `platform:jobid` */
export function buildQueueKeySet(
  items: { platform?: string; job?: { jobId?: string; url?: string } }[],
  platform: JobPlatform
): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const id =
      String(item?.job?.jobId || '').trim() ||
      String(item?.job?.url || '').match(/job_detail\/([^/?#.]+)/i)?.[1] ||
      '';
    const key = seenJobKey(String(item?.platform || platform), id);
    if (key) out.add(key);
  }
  return out;
}
