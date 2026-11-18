// 已扫描索引（seen jobs）
// ---------------------------------------------------------------------------
// 解决的问题：采集链路的「去重」只看 data.pending（全部状态）——AI 判 reject 或低于
// minQueueScore 的岗位**不入队**，下一轮采集仍会被点开、重新提取 JD、重新评分。
// 本索引把「已经评估过」的岗位记下来，让下一次采集在**列表页**就跳过，不点详情。
//
// 失效口径（rulesHash）：索引记录写入时的「筛选规则指纹」。当前 job-analysis 技能正文
// 或标题筛选相关配置变化时，指纹变化 → 旧记录自动失效 → 岗位重新进入评估。
// 这样改 skill（如 v3.4 → v3.5）后不会出现「新规则被旧扫描记录挡住」。
//
// 存储：独立 localStorage 键（不塞进 bossclaw-data，避免把主数据包撑大）。
// 容量：最多 20000 条，按 seenAt 淘汰最旧；默认 TTL 30 天。
import type { JobPlatform } from './types';

export type SeenStage = 'title' | 'jd';

export interface SeenEntry {
  title: string;
  company: string;
  salary?: string;
  seenAt: number;
  rulesHash: string;
  stage: SeenStage;
}

export type SeenMap = Record<string, SeenEntry>;

const STORAGE_KEY = 'bossclaw-seen-jobs-v1';
const MAX_ENTRIES = 20000;
export const DEFAULT_SEEN_TTL_DAYS = 30;

let cache: SeenMap | null = null;
let flushTimer: any = null;

/** 稳定字符串哈希（djb2 双哈希；渲染进程无 node crypto）。用于 rulesHash 与 key。 */
export function stableHash(input: string): string {
  let h1 = 5381;
  let h2 = 52711;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return `${h1.toString(36)}_${h2.toString(36)}`;
}

function readRaw(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SeenMap;
  } catch {
    // 解析失败按空索引处理（宁可重扫，也不能因脏数据阻断采集）
  }
  return {};
}

export function loadSeenJobs(): SeenMap {
  if (!cache) cache = readRaw();
  return cache;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const map = cache;
    if (!map) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
      // 配额超限：丢弃本次持久化（内存索引仍然生效），绝不抛进采集链路
    }
  }, 800);
}

/** 紧急落盘（如「清空」操作后需要立刻生效） */
export function flushSeenJobs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const map = cache;
  if (!map) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 同上：配额超限时静默降级 */
  }
}

export function seenJobKey(platform: JobPlatform | string, jobId: string | null | undefined): string {
  const id = String(jobId || '').trim().toLowerCase();
  if (!id) return '';
  return `${String(platform || '').toLowerCase()}:${id}`;
}

export function isSeenJob(
  map: SeenMap,
  key: string,
  rulesHash: string,
  ttlMs: number,
  now = Date.now()
): SeenEntry | null {
  if (!key) return null;
  const entry = map[key];
  if (!entry) return null;
  if (entry.rulesHash !== rulesHash) return null; // 筛选规则变了 → 视为未评估
  if (ttlMs > 0 && now - Number(entry.seenAt || 0) > ttlMs) return null;
  return entry;
}

/** 批量写入（stage 区分「标题筛掉」还是「走过 JD 评分」） */
export function markSeenJobs(
  items: { platform: JobPlatform | string; jobId: string; title?: string; company?: string; salary?: string }[],
  rulesHash: string,
  stage: SeenStage,
  now = Date.now()
): number {
  const map = loadSeenJobs();
  let written = 0;
  for (const item of items) {
    const key = seenJobKey(item.platform, item.jobId);
    if (!key) continue;
    map[key] = {
      title: String(item.title || '').slice(0, 120),
      company: String(item.company || '').slice(0, 80),
      salary: String(item.salary || '').slice(0, 40),
      seenAt: now,
      rulesHash,
      stage,
    };
    written += 1;
  }
  if (written) {
    pruneSeenJobs(map, now);
    scheduleFlush();
  }
  return written;
}

/** 按 TTL 与容量淘汰（就地修改） */
export function pruneSeenJobs(map: SeenMap, now = Date.now(), ttlMs = 0): SeenMap {
  const keys = Object.keys(map);
  if (ttlMs > 0) {
    for (const k of keys) {
      const at = Number(map[k]?.seenAt || 0);
      if (!at || now - at > ttlMs) delete map[k];
    }
  }
  const rest = Object.keys(map);
  if (rest.length > MAX_ENTRIES) {
    rest
      .sort((a, b) => Number(map[a]?.seenAt || 0) - Number(map[b]?.seenAt || 0))
      .slice(0, rest.length - MAX_ENTRIES)
      .forEach((k) => delete map[k]);
  }
  return map;
}

export function clearSeenJobs(): number {
  const before = Object.keys(loadSeenJobs()).length;
  cache = {};
  flushSeenJobs();
  return before;
}

export function seenJobsStats(): { total: number; byStage: Record<SeenStage, number> } {
  const map = loadSeenJobs();
  const byStage: Record<SeenStage, number> = { title: 0, jd: 0 };
  for (const key of Object.keys(map)) {
    const stage = map[key]?.stage === 'title' ? 'title' : 'jd';
    byStage[stage] += 1;
  }
  return { total: Object.keys(map).length, byStage };
}

export const SEEN_JOBS_STORAGE_KEY = STORAGE_KEY;
