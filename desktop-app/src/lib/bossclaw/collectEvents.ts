// 采集事件库（渲染层入口）
// ---------------------------------------------------------------------------
// 采集链路每扫到一批岗位就记事件，预筛 / 标题筛 / JD 分析只更新阶段，不删事件。
// 目的：招聘趋势统计需要「扫到的全部岗位 + 被哪一步筛掉」，而 pending 只有入队之后、
// seenJobs 只有 key + 时间，都无法支撑市场维度。
//
// 存储：主进程 `<userData>/collect-events/YYYY-MM.jsonl`（见 electron/collectEventStore.cjs）。
// 本模块只做三件事：
//   ① 把 ListCardRecord / JobMeta 归一成 CollectEvent（薪资、城市、职级、技术标签、团队规模）；
//   ② 合并同一岗位的多次扫描与阶段更新（key = platform:jobId）；
//   ③ 1.2s 防抖批量写盘（IPC 不可用 / 浏览器预览时静默降级为空操作）。
//
// 只记录 BOSS / 猎聘的**自动采集**事件；不记录手动「加入任务」的岗位，避免污染市场口径。
import type { JobMeta, JobPlatform } from './types';
import { parseSalaryRange } from './jobMatch';
import { hrActivityRank } from './hrActivity';
import { listCardJobId, type ListCardRecord } from './listPrefilter';
import { stableHash } from './seenJobs';

export type CollectEventStage =
  | 'scanned'
  | 'filtered'
  | 'prefilter_excluded'
  | 'title_excluded'
  | 'jd_excluded'
  | 'qualified'
  | 'sent';

export type CollectSourceType = 'recommend-tab' | 'list' | 'camoufox';

export interface CollectEvent {
  key: string;
  platform: 'boss' | 'liepin';
  jobId: string;
  title: string;
  company: string;
  salaryText: string;
  salaryLowK: number | null;
  salaryHighK: number | null;
  locationRaw: string;
  city: string;
  postedAtApprox: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  scanCount: number;
  directionId: string;
  directionName: string;
  keyword: string;
  sourceType: CollectSourceType;
  level: string;
  techTags: string[];
  teamSize: string;
  hrActive: string;
  isHeadhunter: boolean;
  stage: CollectEventStage;
  excludeStage: string;
  reason: string;
  updatedAt: number;
}

export interface CollectCaptureContext {
  platform: JobPlatform;
  directionId?: string;
  directionName?: string;
  keyword?: string;
  sourceType: CollectSourceType;
}

export interface CollectEventUsage {
  ok: boolean;
  count: number;
  bytes: number;
  months: number;
  oldest: number;
  newest: number;
  retentionDays: number;
  error?: string;
}

const RECORDED_PLATFORMS = new Set<string>(['boss', 'liepin']);
const FLUSH_DELAY_MS = 1200;
/** 常用技术词典（通用，个人方向由现有「投递方向」配置提供，不在此硬编码） */
const TECH_DICTIONARY = [
  '大模型', 'LLM', 'Agent', 'RAG', 'Prompt', 'MCP', 'AIGC', '多模态', 'Transformer',
  'Java', 'Python', 'Go', 'C++', 'C#', 'Rust', 'Node.js', 'TypeScript', 'JavaScript',
  'React', 'Vue', 'Angular', '前端', '后端', '全栈', '小程序', '鸿蒙',
  '微服务', '云原生', 'Kubernetes', 'Docker', 'Serverless', '分布式', '高并发', '中间件',
  '大数据', 'Spark', 'Flink', 'Hadoop', '数据平台', '数据中台', '数据仓库', 'BI',
  '机器学习', '深度学习', '推荐系统', '搜索', '广告', '风控', '支付', '电商', 'SaaS',
  'ERP', 'CRM', '供应链', '物联网', 'IoT', '音视频', '可视化', '低代码',
  '架构设计', '技术管理', '团队管理', '研发效能', 'DevOps',
];

function nowMs(): number {
  return Date.now();
}

function clip(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function jobIdFromUrl(url: unknown): string {
  return String(url || '').match(/job_detail\/([^/?#.]+)/i)?.[1] || '';
}

export function normalizeJobId(raw: unknown): string {
  let id = String(raw || '').trim();
  const kv = id.match(/(?:encryptJobId|jobId|securityId|lid)=([^&?#]+)/i);
  if (kv) id = kv[1];
  return id.replace(/\.html$/i, '').trim().slice(0, 120);
}

export function normalizeCity(location: unknown): string {
  const raw = String(location || '').trim();
  if (!raw) return '';
  const first = raw.split(/[·\-—/|,，\s]/).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (!first || /^(全国|不限|远程)$/.test(first)) return '';
  return first.replace(/市$/, '').slice(0, 20);
}

/** 薪资只取「月薪基数」：日薪 / 时薪 / 年薪统一折算，面议返回 null */
function parseSalary(salary: unknown): { low: number | null; high: number | null } {
  const r = parseSalaryRange(String(salary || ''));
  if (!r.valid || !Number.isFinite(r.low) || r.low <= 0) return { low: null, high: null };
  const low = Math.round(r.low * 10) / 10;
  const high = Math.round((r.high || r.low) * 10) / 10;
  return { low, high: high >= low ? high : low };
}

/** 发布时间 → 近似时间戳（BOSS/猎聘大多是相对文本；识别不了返回 null，不猜） */
export function parsePostedAtApprox(text: unknown, now = nowMs()): number | null {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/刚刚|分钟前|小时前|今天|今日/.test(s)) return now;
  const day = s.match(/(\d+)\s*天前/);
  if (day) return now - Number(day[1]) * 86400000;
  if (/昨天/.test(s)) return now - 86400000;
  if (/前天/.test(s)) return now - 2 * 86400000;
  if (/本周|这周/.test(s)) return now - 3 * 86400000;
  if (/本月|这个月/.test(s)) return now - 15 * 86400000;
  const week = s.match(/(\d+)\s*周前/);
  if (week) return now - Number(week[1]) * 7 * 86400000;
  const month = s.match(/(\d+)\s*个?月前/);
  if (month) return now - Number(month[1]) * 30 * 86400000;
  const ymd = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (ymd) {
    const t = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const md = s.match(/(\d{1,2})[-/.月](\d{1,2})/);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      let t = new Date(new Date(now).getFullYear(), m - 1, d, 12).getTime();
      if (t > now + 86400000) t = new Date(new Date(now).getFullYear() - 1, m - 1, d, 12).getTime();
      return t;
    }
  }
  return null;
}

/** 标题 → 职级桶（粗粒度，够做分布；不猜具体头衔） */
export function deriveLevel(title: unknown): string {
  const t = String(title || '');
  if (/CTO|首席技术官|技术副总裁|研发副总裁|技术合伙人|VP\b/i.test(t)) return '高管/VP';
  if (/总监|总师|负责人|一号位/.test(t)) return '总监/负责人';
  if (/架构师|架构/.test(t)) return '架构师';
  if (/经理|主管|组长|Leader|负责人/i.test(t)) return '经理/主管';
  if (/专家|资深|高级|首席/.test(t)) return '专家/资深';
  if (/工程师|开发|研发|程序员/.test(t)) return '工程师';
  if (!t.trim()) return '未知';
  return '其他';
}

export function extractTechTags(text: unknown): string[] {
  const s = String(text || '');
  if (!s) return [];
  const out: string[] = [];
  for (const tag of TECH_DICTIONARY) {
    if (out.length >= 8) break;
    const re = /^[A-Za-z0-9.+#]+$/.test(tag)
      ? new RegExp(`(^|[^A-Za-z0-9.+#])${tag.replace(/[.+]/g, '\\$&')}([^A-Za-z0-9.+#]|$)`, 'i')
      : new RegExp(tag, 'i');
    if (re.test(s)) out.push(tag);
  }
  return out;
}

/** 从 JD 文本抓团队规模（只认明确数字，抓不到留空） */
export function extractTeamSize(text: unknown): string {
  const s = String(text || '');
  const m =
    s.match(/(?:管理|带领|负责|团队规模|团队人数|研发团队)[^\d\n。；]{0,10}(\d{1,4})\s*(?:\+)?\s*人/) ||
    s.match(/(\d{1,4})\s*人(?:以上)?(?:团队|研发团队)/);
  if (!m) return '';
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 10000 ? String(n) : '';
}

function baseEvent(platform: JobPlatform, ctx: CollectCaptureContext, now: number): Pick<
  CollectEvent,
  'platform' | 'directionId' | 'directionName' | 'keyword' | 'sourceType' | 'firstSeenAt' | 'lastSeenAt' | 'updatedAt'
> | null {
  if (!RECORDED_PLATFORMS.has(platform)) return null;
  return {
    platform: platform as 'boss' | 'liepin',
    directionId: clip(ctx.directionId, 80),
    directionName: clip(ctx.directionName, 80),
    keyword: clip(ctx.keyword, 80),
    sourceType: ctx.sourceType,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  };
}

function makeEventKey(platform: string, jobId: string, identity: string): string {
  if (jobId) return `${platform}:${jobId.toLowerCase()}`;
  return `${platform}:h:${stableHash(identity)}`;
}

export function eventFromCard(card: ListCardRecord, ctx: CollectCaptureContext, now = nowMs()): CollectEvent | null {
  const base = baseEvent(ctx.platform, ctx, now);
  if (!base) return null;
  const jobId = listCardJobId(card);
  const title = clip(card.title, 160);
  const company = clip(card.company, 120);
  const salaryText = clip(card.salary, 60);
  const locationRaw = clip(card.location, 80);
  const identity = [title, company, salaryText, locationRaw].join('|');
  if (!title && !jobId) return null;
  const salary = parseSalary(salaryText);
  return {
    ...base,
    key: makeEventKey(base.platform, jobId, identity),
    jobId,
    title,
    company,
    salaryText,
    salaryLowK: salary.low,
    salaryHighK: salary.high,
    locationRaw,
    city: normalizeCity(locationRaw),
    postedAtApprox: null,
    scanCount: 1,
    level: deriveLevel(title),
    techTags: extractTechTags(`${title} ${card.raw || ''}`),
    teamSize: '',
    hrActive: clip(card.hrActive, 30),
    isHeadhunter: Boolean(card.isHeadhunter),
    stage: 'scanned',
    excludeStage: '',
    reason: '',
  };
}

export function eventFromJob(job: JobMeta, ctx: CollectCaptureContext, opts: { countAsScan?: boolean } = {}): CollectEvent | null {
  const now = nowMs();
  const base = baseEvent(ctx.platform, ctx, now);
  if (!base) return null;
  const jobId = normalizeJobId(job.jobId) || jobIdFromUrl(job.url);
  const title = clip(job.title, 160);
  const company = clip(job.company, 120);
  const salaryText = clip(job.salary, 60);
  const locationRaw = clip(job.location, 80);
  if (!title && !jobId) return null;
  const identity = [title, company, salaryText, locationRaw].join('|');
  const salary = parseSalary(salaryText);
  const extraTags = [
    ...(Array.isArray((job as any).skills) ? (job as any).skills : []),
    ...(Array.isArray((job as any).labels) ? (job as any).labels : []),
  ].join(' ');
  return {
    ...base,
    key: makeEventKey(base.platform, jobId, identity),
    jobId,
    title,
    company,
    salaryText,
    salaryLowK: salary.low,
    salaryHighK: salary.high,
    locationRaw,
    city: normalizeCity(locationRaw),
    postedAtApprox: parsePostedAtApprox(job.publishTime, now),
    scanCount: opts.countAsScan ? 1 : 0,
    level: deriveLevel(title),
    techTags: extractTechTags(`${title} ${extraTags} ${job.description || ''}`),
    teamSize: extractTeamSize(job.description),
    hrActive: clip(job.hrActive, 30),
    isHeadhunter: Boolean(job.isHeadhunter),
    stage: 'scanned',
    excludeStage: '',
    reason: '',
  };
}

/* ============================ 本地合并 & 写盘队列 ============================ */

const pending = new Map<string, CollectEvent>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> = Promise.resolve();

function mergeLocal(prev: CollectEvent | undefined, next: CollectEvent): CollectEvent {
  if (!prev) return next;
  // 扫描 / 详情补全（stage='scanned'）只更新元数据，不覆盖已有判定；
  // 真正的筛选 / 评分更新覆盖阶段（上一轮被筛、这一轮通过时以最新判定为准）。
  const stageNext = next.stage !== 'scanned';
  const stageSource = stageNext ? next : prev;
  const isUpdate = next.scanCount === 0;
  const pickStr = (k: keyof CollectEvent) => {
    const v = next[k];
    return typeof v === 'string' && v ? v : prev[k];
  };
  return {
    ...prev,
    ...next,
    firstSeenAt: isUpdate ? prev.firstSeenAt : Math.min(prev.firstSeenAt, next.firstSeenAt),
    lastSeenAt: isUpdate ? prev.lastSeenAt : Math.max(prev.lastSeenAt, next.lastSeenAt),
    scanCount: (prev.scanCount || 0) + (next.scanCount || 0),
    updatedAt: Math.max(prev.updatedAt, next.updatedAt, nowMs()),
    title: pickStr('title') as string,
    company: pickStr('company') as string,
    salaryText: pickStr('salaryText') as string,
    salaryLowK: next.salaryLowK ?? prev.salaryLowK,
    salaryHighK: next.salaryHighK ?? prev.salaryHighK,
    locationRaw: pickStr('locationRaw') as string,
    city: pickStr('city') as string,
    postedAtApprox: next.postedAtApprox ?? prev.postedAtApprox,
    directionId: pickStr('directionId') as string,
    directionName: pickStr('directionName') as string,
    keyword: pickStr('keyword') as string,
    level: pickStr('level') as string,
    techTags: next.techTags.length ? next.techTags : prev.techTags,
    teamSize: pickStr('teamSize') as string,
    hrActive: pickStr('hrActive') as string,
    isHeadhunter: prev.isHeadhunter || next.isHeadhunter,
    stage: stageSource.stage,
    excludeStage: stageSource.excludeStage,
    reason: stageSource.reason,
  };
}

function enqueue(ev: CollectEvent | null): void {
  if (!ev) return;
  pending.set(ev.key, mergeLocal(pending.get(ev.key), ev));
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCollectEvents();
  }, FLUSH_DELAY_MS);
}

/** 立即把内存中的事件写盘（采集结束 / 页面卸载前调用；失败只记 console，不影响采集） */
export async function flushCollectEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.size) return flushing;
  const batch = Array.from(pending.values());
  pending.clear();
  const api = window.electron?.collectEventsUpsert;
  if (!api) return;
  flushing = flushing.then(async () => {
    try {
      await api(batch);
    } catch (e) {
      console.warn('[collect-events] 写入失败', e);
    }
  });
  return flushing;
}

/* ============================ 采集链路调用点 ============================ */

/** 列表扫描：整页卡片（含本轮去重掉的）都记为一次「在架」观察，热度 = 同岗位被扫到的次数 */
export function captureCollectCards(cards: ListCardRecord[], ctx: CollectCaptureContext): void {
  if (!Array.isArray(cards) || !cards.length) return;
  for (const card of cards) enqueue(eventFromCard(card, ctx));
}

/** 详情阶段：补全 JD 派生维度（技术标签 / 团队规模）；recommend-tab 已在扫描阶段记过，不重复计热度 */
export function captureCollectJob(job: JobMeta, ctx: CollectCaptureContext): void {
  enqueue(eventFromJob(job, ctx, { countAsScan: ctx.sourceType !== 'recommend-tab' }));
}

export interface CollectExclusion {
  card?: ListCardRecord;
  job?: JobMeta;
  reason?: string;
  /** 排除阶段细分（预筛原因 / 标题筛 / JD 评分），用于统计页「主要流失原因」 */
  excludeStage?: string;
}

/** 预筛 / 标题筛 / JD 筛 / 入队：只更新阶段，不新增一条事件 */
export function markCollectEventsStage(
  items: CollectExclusion[],
  ctx: CollectCaptureContext,
  stage: CollectEventStage,
  opts: { excludeStage?: string; reason?: string } = {}
): void {
  for (const item of items) {
    const base = item.card
      ? eventFromCard(item.card, ctx)
      : item.job
        ? eventFromJob(item.job, ctx, { countAsScan: false })
        : null;
    if (!base) continue;
    enqueue({
      ...base,
      scanCount: 0,
      stage,
      excludeStage: clip(opts.excludeStage ?? item.excludeStage ?? item.reason, 40),
      reason: clip(opts.reason ?? item.reason, 200),
    });
  }
}

/** 单岗位阶段更新（ingestJob 的过滤 / 评分路径；job 也用于补全缺失元数据） */
export function updateCollectEventStage(
  job: JobMeta,
  ctx: CollectCaptureContext,
  stage: CollectEventStage,
  opts: { excludeStage?: string; reason?: string } = {}
): void {
  const ev = eventFromJob(job, ctx, { countAsScan: false });
  if (!ev) return;
  enqueue({
    ...ev,
    scanCount: 0,
    stage,
    excludeStage: clip(opts.excludeStage, 40),
    reason: clip(opts.reason, 200),
  });
}

/* ============================ 读取 / 管理 ============================ */

function isCollectEvent(v: unknown): v is CollectEvent {
  const e = v as Partial<CollectEvent>;
  return Boolean(e && typeof e.key === 'string' && (e.platform === 'boss' || e.platform === 'liepin'));
}

export async function loadCollectEvents(from: number, to = Date.now()): Promise<CollectEvent[]> {
  const api = window.electron?.collectEventsLoad;
  if (!api) return [];
  try {
    const res = await api({ from, to });
    return res?.ok && Array.isArray(res.events) ? res.events.filter(isCollectEvent) : [];
  } catch {
    return [];
  }
}

export async function collectEventsUsage(): Promise<CollectEventUsage | null> {
  const api = window.electron?.collectEventsUsage;
  if (!api) return null;
  try {
    const res = await api();
    return res?.ok
      ? {
          ok: true,
          count: Number(res.count) || 0,
          bytes: Number(res.bytes) || 0,
          months: Number(res.months) || 0,
          oldest: Number(res.oldest) || 0,
          newest: Number(res.newest) || 0,
          retentionDays: Number(res.retentionDays) || 365,
        }
      : null;
  } catch {
    return null;
  }
}

export async function clearCollectEvents(): Promise<boolean> {
  const api = window.electron?.collectEventsClear;
  if (!api) return false;
  try {
    const res = await api();
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

export { hrActivityRank };
