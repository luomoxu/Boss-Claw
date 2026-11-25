// 采集事件文件仓储（招聘趋势分析的唯一事实源）
// ---------------------------------------------------------------------------
// 位置：`<userData>/collect-events/YYYY-MM.jsonl`，每行一个岗位事件（JSON）。
//
// 为什么单独存：
//   - pending 只保留「入队之后」的岗位，列表页预筛 / AI 标题筛掉的岗位完全不留痕；
//   - seenJobs 只有 key + seenAt，没有标题 / 薪资 / 城市等市场维度；
//   - 招聘趋势需要「扫到的全部岗位 + 筛掉的阶段」，因此采集链路把每次扫描记成事件。
//
// 事件身份 = `platform:jobId`（无 jobId 时由渲染层用标题/公司生成稳定回退键）。
// 同一岗位多次扫到 → 合并为一条，scanCount +1、lastSeenAt 更新，firstSeenAt 不变。
//
// 分片与保留：
//   - 按 lastSeenAt 所在月份分片；事件跨月更新时从旧分片移到新分片。
//   - 保留 365 天：启动加载 / usage 时删除过期月份文件（整月粒度，最多多留 31 天）。
//   - 不设条数上限（用户已确认），单条事件只存分析维度，不存 JD 正文。
'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;

const RETENTION_DAYS = 365;
const MAX_EVENT_BYTES = 16 * 1024;

const pad2 = (n) => String(n).padStart(2, '0');
const monthKeyOf = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const monthStartMs = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).getTime();
};
const nextMonthKey = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  const d = new Date(y, m || 1, 1); // 月份从 0 计：y, m 即下个月
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};

function createCollectEventStore({ baseDir }) {
  const dir = () => path.join(baseDir(), 'collect-events');
  /** @type {Map<string, any>} key -> event */
  let events = new Map();
  let loaded = false;
  /** @type {Set<string>} 已加载过的分片（YYYY-MM） */
  const loadedMonths = new Set();
  let writeChain = Promise.resolve();

  const cutoffMonth = () => monthKeyOf(Date.now() - RETENTION_DAYS * 86400000);

  async function ensureDir() {
    await fsp.mkdir(dir(), { recursive: true });
  }

  async function listShardMonths() {
    try {
      const names = await fsp.readdir(dir());
      return names
        .filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n))
        .map((n) => n.slice(0, 7))
        .sort();
    } catch {
      return [];
    }
  }

  async function readMonth(month) {
    if (loadedMonths.has(month)) return;
    loadedMonths.add(month);
    const file = path.join(dir(), `${month}.jsonl`);
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        if (ev && typeof ev.key === 'string' && ev.key) events.set(ev.key, ev);
      } catch {
        // 单行损坏只丢该行：事件库是派生统计源，不能因一行坏数据整库不可用
      }
    }
  }

  async function loadAll({ prune = true } = {}) {
    if (loaded) return;
    loaded = true;
    const months = await listShardMonths();
    if (prune) {
      const cut = cutoffMonth();
      const stale = months.filter((m) => m < cut);
      for (const m of stale) {
        try { await fsp.unlink(path.join(dir(), `${m}.jsonl`)); } catch { /* ignore */ }
      }
      for (const m of months) if (!stale.includes(m)) await readMonth(m);
    } else {
      for (const m of months) await readMonth(m);
    }
  }

  function sanitize(input) {
    if (!input || typeof input !== 'object') return null;
    const key = String(input.key || '').trim().slice(0, 200);
    if (!key) return null;
    const platform = input.platform === 'liepin' ? 'liepin' : input.platform === 'boss' ? 'boss' : '';
    if (!platform) return null;
    const firstSeenAt = Number(input.firstSeenAt) || Date.now();
    const lastSeenAt = Number(input.lastSeenAt) || firstSeenAt;
    const numOrNull = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    };
    const tags = Array.isArray(input.techTags)
      ? input.techTags.map((x) => String(x || '').trim().slice(0, 24)).filter(Boolean).slice(0, 12)
      : [];
    const ev = {
      key,
      platform,
      jobId: String(input.jobId || '').slice(0, 120),
      title: String(input.title || '').slice(0, 160),
      company: String(input.company || '').slice(0, 120),
      salaryText: String(input.salaryText || '').slice(0, 60),
      salaryLowK: numOrNull(input.salaryLowK),
      salaryHighK: numOrNull(input.salaryHighK),
      locationRaw: String(input.locationRaw || '').slice(0, 80),
      city: String(input.city || '').slice(0, 40),
      postedAtApprox: numOrNull(input.postedAtApprox),
      firstSeenAt,
      lastSeenAt,
      // scanCount = 本次批量里「实际扫到该岗位」的次数；阶段更新传 0，不伪造一次新扫描
      scanCount: Math.max(0, Math.min(100000, Math.round(Number(input.scanCount) || 0))),
      directionId: String(input.directionId || '').slice(0, 80),
      directionName: String(input.directionName || '').slice(0, 80),
      keyword: String(input.keyword || '').slice(0, 80),
      sourceType: ['recommend-tab', 'list', 'camoufox'].includes(input.sourceType) ? input.sourceType : 'list',
      level: String(input.level || '').slice(0, 20),
      techTags: tags,
      teamSize: String(input.teamSize || '').slice(0, 24),
      hrActive: String(input.hrActive || '').slice(0, 30),
      isHeadhunter: Boolean(input.isHeadhunter),
      stage: ['scanned', 'prefilter_excluded', 'title_excluded', 'jd_excluded', 'qualified', 'sent', 'filtered'].includes(input.stage)
        ? input.stage
        : 'scanned',
      excludeStage: String(input.excludeStage || '').slice(0, 40),
      reason: String(input.reason || '').slice(0, 200),
      updatedAt: Number(input.updatedAt) || Date.now(),
    };
    if (Buffer.byteLength(JSON.stringify(ev), 'utf8') > MAX_EVENT_BYTES) return null;
    return ev;
  }

  function mergeEvent(prev, next) {
    if (!prev) return next;
    // 更新语义：新事件字段优先；扫描计数累加；firstSeenAt 取更早。
    // 阶段：「扫描 / 详情补全」带 stage='scanned'，不覆盖已有判定；只有真正的筛选/评分更新
    // （stage !== 'scanned'）才覆盖——上一轮被筛、这一轮通过时以最新判定为准。
    const pick = (f) => (next[f] !== '' && next[f] !== null && next[f] !== undefined ? next[f] : prev[f]);
    const stageNext = next.stage !== 'scanned';
    const stageSource = stageNext ? next : prev;
    // 阶段更新（scanCount=0）只改判定字段，不推进 firstSeen / lastSeen / 热度
    const isUpdate = Number(next.scanCount) === 0;
    return {
      ...prev,
      ...next,
      firstSeenAt: isUpdate ? prev.firstSeenAt : Math.min(prev.firstSeenAt || next.firstSeenAt, next.firstSeenAt || prev.firstSeenAt),
      lastSeenAt: isUpdate ? prev.lastSeenAt : Math.max(prev.lastSeenAt || 0, next.lastSeenAt || 0),
      scanCount: (Number(prev.scanCount) || 0) + (Number(next.scanCount) || 0),
      title: pick('title'),
      company: pick('company'),
      salaryText: pick('salaryText'),
      salaryLowK: next.salaryLowK ?? prev.salaryLowK,
      salaryHighK: next.salaryHighK ?? prev.salaryHighK,
      locationRaw: pick('locationRaw'),
      city: pick('city'),
      postedAtApprox: next.postedAtApprox ?? prev.postedAtApprox,
      directionId: pick('directionId'),
      directionName: pick('directionName'),
      keyword: pick('keyword'),
      level: pick('level'),
      techTags: (next.techTags && next.techTags.length ? next.techTags : prev.techTags) || [],
      teamSize: pick('teamSize'),
      hrActive: pick('hrActive'),
      isHeadhunter: Boolean(prev.isHeadhunter || next.isHeadhunter),
      stage: stageSource.stage,
      excludeStage: stageSource.excludeStage,
      reason: stageSource.reason,
      sourceType: next.sourceType || prev.sourceType,
      updatedAt: Math.max(Number(prev.updatedAt) || 0, Number(next.updatedAt) || 0, Date.now()),
    };
  }

  async function writeMonth(month, list) {
    await ensureDir();
    const file = path.join(dir(), `${month}.jsonl`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const body = list.map((ev) => JSON.stringify(ev)).join('\n') + (list.length ? '\n' : '');
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, file);
  }

  /** 串行化写盘：多个 IPC 批次的 upsert 不会互相覆盖分片 */
  function enqueueWrite(task) {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  }

  async function upsert(inputEvents) {
    if (!Array.isArray(inputEvents)) return { ok: false, error: '事件列表格式错误' };
    await loadAll();
    const byMonth = new Map();
    const touched = new Set();
    let accepted = 0;
    for (const raw of inputEvents.slice(0, 5000)) {
      const next = sanitize(raw);
      if (!next) continue;
      const prev = events.get(next.key);
      const merged = mergeEvent(prev, next);
      const oldMonth = prev ? monthKeyOf(prev.lastSeenAt) : '';
      const newMonth = monthKeyOf(merged.lastSeenAt);
      if (oldMonth && oldMonth !== newMonth) touched.add(oldMonth);
      touched.add(newMonth);
      events.set(next.key, merged);
      accepted += 1;
    }
    if (!accepted) return { ok: true, count: 0 };
    // 每个受影响月份重写一次完整分片（事件库规模是「月内岗位数」，可接受）
    for (const m of touched) {
      const list = [];
      for (const ev of events.values()) {
        if (monthKeyOf(ev.lastSeenAt) === m) list.push(ev);
      }
      byMonth.set(m, list);
    }
    return enqueueWrite(async () => {
      for (const [m, list] of byMonth) await writeMonth(m, list);
      return { ok: true, count: accepted };
    });
  }

  async function load({ from = 0, to = Date.now() } = {}) {
    await loadAll();
    const fromMs = Number(from) || 0;
    const toMs = Number(to) || Date.now();
    const out = [];
    for (const ev of events.values()) {
      // 区间语义：统计时「新发现」看 firstSeenAt、「在架」看 lastSeenAt，两者任一落入区间都返回，
      // 具体口径由渲染层聚合决定。
      if ((ev.lastSeenAt >= fromMs && ev.firstSeenAt <= toMs) || (ev.firstSeenAt >= fromMs && ev.firstSeenAt <= toMs)) {
        out.push(ev);
      }
    }
    return { ok: true, events: out };
  }

  async function usage() {
    await loadAll();
    const months = await listShardMonths();
    let bytes = 0;
    for (const m of months) {
      try {
        const st = await fsp.stat(path.join(dir(), `${m}.jsonl`));
        bytes += st.size;
      } catch { /* ignore */ }
    }
    let oldest = 0;
    let newest = 0;
    for (const ev of events.values()) {
      const t = Number(ev.firstSeenAt) || 0;
      if (t && (!oldest || t < oldest)) oldest = t;
      const l = Number(ev.lastSeenAt) || 0;
      if (l > newest) newest = l;
    }
    return { ok: true, count: events.size, bytes, months: months.length, oldest, newest, retentionDays: RETENTION_DAYS };
  }

  async function clear() {
    await writeChain.catch(() => {});
    const months = await listShardMonths();
    for (const m of months) {
      try { await fsp.unlink(path.join(dir(), `${m}.jsonl`)); } catch { /* ignore */ }
    }
    events = new Map();
    loadedMonths.clear();
    loaded = true;
    return { ok: true };
  }

  return { upsert, load, usage, clear };
}

module.exports = { createCollectEventStore };
