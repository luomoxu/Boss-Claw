// BOSS 推荐页 tab 发现 / 切换
// ---------------------------------------------------------------------------
// 背景：`/web/geek/jobs`（不带 query）是 BOSS 根据账号「求职意向」生成的推荐页，页内有
// 推荐 / 技术经理(成都) / 架构师(成都) / 技术总监(成都) 等多个 tab。**切 tab 是 SPA 状态，
// URL 不变**，所以只能靠点击切换，不能拼 URL 直达。
//
// 为什么不走推荐接口：站方的推荐 API 属于强风控面（且不在白名单内），本模块只通过
// `getBrowser().uiExec` 做「查询可见 tab → 点击 → 等列表变化」这类等价于人工点击的操作。
//
// 失败口径：发现失败 / 点击失败 / 等不到列表变化，都**不抛异常**，由调用方降级
// （发现失败 → 只采默认 tab；切换超时 → 仍按当前列表继续扫，只是记一条 warn）。
import { getBrowser } from '../browserRegistry';

/** 实测命中：推荐页 tab 容器 class 含 expect，锚点为具体 tab */
export const RECOMMEND_TAB_SELECTOR = '[class*="expect"] a';
/** 卡片选择器（与 webview.cjs collectCards 的 BOSS 主选择器一致） */
const CARD_SELECTOR = 'li.job-card-box';
/** 这些锚点也在 expect 容器附近，但不是推荐 tab */
const NON_TAB_LABELS = new Set(['地图', '搜索']);
const TAB_POLL_INTERVAL_MS = 600;

export interface RecommendTab {
  label: string;
  /** 发现顺序（0 一般是「推荐」） */
  index: number;
}

export interface DiscoverTabsResult {
  tabs: RecommendTab[];
  error?: string;
}

export interface SwitchTabResult {
  ok: boolean;
  /** 列表内容是否被观测到变化 */
  switched: boolean;
  /** 是否真的发起了点击（第一个 tab 已经在默认选中态时不需要点） */
  clicked: boolean;
  error?: string;
}

function errText(e: any): string {
  return String(e?.message || e || '未知错误');
}

async function queryTexts(selector: string, limit: number, tabId?: string, timeoutMs = 8000): Promise<{ texts: string[]; error?: string }> {
  const b = getBrowser();
  if (!b) return { texts: [], error: '浏览器未就绪' };
  try {
    const res = await b.uiExec('query', { selector, limit }, timeoutMs, tabId);
    if (!res?.ok) return { texts: [], error: String(res?.result?.error || res?.error || '页面查询失败') };
    const els: any[] = Array.isArray(res.result?.elements) ? res.result.elements : [];
    return { texts: els.map((el) => String(el?.text || '').replace(/\s+/g, ' ').trim()) };
  } catch (e) {
    return { texts: [], error: errText(e) };
  }
}

/** 发现推荐 tab（按页面顺序，已过滤「地图 / 搜索」与重复项）。 */
export async function discoverRecommendTabs(opts: { tabId?: string; timeoutMs?: number } = {}): Promise<DiscoverTabsResult> {
  const { texts, error } = await queryTexts(RECOMMEND_TAB_SELECTOR, 40, opts.tabId, opts.timeoutMs ?? 8000);
  if (error) return { tabs: [], error };
  const seen = new Set<string>();
  const tabs: RecommendTab[] = [];
  for (const text of texts) {
    if (!text || text.length > 30) continue;
    if (NON_TAB_LABELS.has(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    tabs.push({ label: text, index: tabs.length });
  }
  if (!tabs.length) return { tabs: [], error: '未在页面找到推荐 tab（选择器无命中）' };
  return { tabs };
}

/** 列表首屏采样张数（用于判断「点了 tab 之后列表是否换了」） */
const FINGERPRINT_CARDS = 10;

interface ListFingerprint {
  texts: string[];
}

async function listFingerprint(tabId?: string): Promise<ListFingerprint> {
  const { texts } = await queryTexts(CARD_SELECTOR, FINGERPRINT_CARDS, tabId, 6000);
  return { texts: texts.map((t) => t.slice(0, 80)) };
}

/**
 * 判断两次首屏指纹是否「换过列表」。
 *
 * 不能用「完全相等才叫没换」：不同意向 tab 的首屏本来就高度重叠（同一批热门岗位会同时命中
 * 推荐 / 技术经理 / 架构师），旧实现只比前 3 张、必须完全不同，重叠时会把**成功的切换**
 * 误判成超时（日志：等待列表切换超时），随后按旧列表继续扫描。
 * 现在改为「至少换掉 1/3 且不少于 2 张」才算切换，并在超时日志里带上重叠张数便于判断。
 */
function fingerprintDelta(
  before: ListFingerprint,
  after: ListFingerprint
): { changed: boolean; overlap: number; compared: number } {
  const compared = after.texts.length;
  if (!compared) return { changed: false, overlap: 0, compared: 0 };
  // 点击瞬间列表被卸载成骨架屏时，旧基数为空；此时首屏重新出现卡片即视为已刷新
  if (!before.texts.length) return { changed: true, overlap: 0, compared };
  const beforeSet = new Set(before.texts);
  const overlap = after.texts.filter((t) => beforeSet.has(t)).length;
  const changed = compared - overlap >= Math.max(2, Math.ceil(compared / 3));
  return { changed, overlap, compared };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把列表滚回顶部（切 tab 后浏览器不一定复位滚动位置；扫 tab 必须从第一张卡开始） */
export async function scrollListToTop(tabId?: string): Promise<void> {
  const b = getBrowser();
  if (!b) return;
  try {
    // 实测：`to:'bottom'` 走 scrollIntoView，对 BOSS 本页无效；必须用 dy 才有滚动效果。
    await b.uiExec('scroll', { selector: 'html', dy: -200000 }, 6000, tabId);
  } catch {
    /* 滚动失败不影响后续扫描（scan 自己也会滚） */
  }
}

/**
 * 切到指定 tab。
 *
 * @param tab           discoverRecommendTabs 的结果
 * @param opts.expectChange 是否要求「列表内容必须变化」（第一个 tab 默认选中时传 false）
 * @param opts.waitMs  等列表变化的超时（默认 15s）
 */
export async function switchRecommendTab(
  tab: RecommendTab,
  opts: { tabId?: string; expectChange?: boolean; waitMs?: number } = {}
): Promise<SwitchTabResult> {
  const { tabId, waitMs = 15000 } = opts;
  const expectChange = opts.expectChange !== false;
  const b = getBrowser();
  if (!b) return { ok: false, switched: false, clicked: false, error: '浏览器未就绪' };

  // 基线必须在「列表顶部」采样（见下方说明）；第一个 tab 不用点击时也顺手归位
  await scrollListToTop(tabId);
  // 第一个 tab 就是页面默认选中的「推荐」：不点击，直接扫当前列表
  if (!expectChange) return { ok: true, switched: true, clicked: false };

  let before = await listFingerprint(tabId);
  let clicked = false;
  let lastDelta = { changed: false, overlap: before.texts.length, compared: before.texts.length };

  // 最多点两次：首击可能被骨架屏 / 过渡遮罩吞掉（点击成功但列表没动），
  // 再点一次的成本远低于漏掉整个 tab 的岗位。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await sleep(1200);
      await scrollListToTop(tabId);
      // 以「重试点击前」的列表为新基线：首击后列表可能已经部分更新
      before = await listFingerprint(tabId);
    }
    try {
      const res = await b.uiExec('click', { selector: RECOMMEND_TAB_SELECTOR, label: tab.label, index: 0 }, 8000, tabId);
      if (!res?.ok) {
        const msg = String(res?.result?.error || res?.error || '点击 tab 失败');
        // 首击失败 = 这个 tab 点不动，交给宿主跳过；重试失败时首击已经生效过，
        // 按「切换未确认」放行，继续扫当前列表（跳过整 tab 的代价更大）。
        if (attempt > 0) return { ok: true, switched: false, clicked, error: `重试点击失败：${msg}` };
        return { ok: false, switched: false, clicked, error: msg };
      }
      clicked = true;
    } catch (e) {
      const msg = errText(e);
      if (attempt > 0) return { ok: true, switched: false, clicked, error: `重试点击异常：${msg}` };
      return { ok: false, switched: false, clicked, error: msg };
    }

    await scrollListToTop(tabId);

    // 轮询到「列表首屏指纹变化 / 超时」。BOSS 切 tab 后是异步拉列表，没有可用的同步信号，
    // 只能以列表内容的事实变化为准（见 fingerprintDelta：重叠 2/3 以内即认可切换）。
    // 注意 before 已在滚动到顶部之后采样：上一阶段（详情采集）结束时列表停在底部，
    // 若在底部采样，会被「滚回顶部」本身误判成「tab 已切换」。
    const wait = attempt === 0 ? waitMs : 10000;
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      await sleep(TAB_POLL_INTERVAL_MS);
      const now = await listFingerprint(tabId);
      lastDelta = fingerprintDelta(before, now);
      if (lastDelta.changed) {
        await scrollListToTop(tabId);
        return { ok: true, switched: true, clicked };
      }
    }
  }
  // 超时不等于失败：列表可能本来就和新 tab 的首屏高度重叠，或该 tab 已是当前选中。
  // 放行继续扫，由宿主记 warn + 去重兜底；日志带上重叠张数便于判断到底是哪种情况。
  return {
    ok: true,
    switched: false,
    clicked,
    error: `等待列表切换超时（${Math.round((waitMs + 10000) / 1000)}s，首屏 ${lastDelta.compared} 张中 ${lastDelta.overlap} 张未变化）`,
  };
}

/**
 * 供 Workbench 调用的切 tab 入口：第一个 tab（页面默认选中的「推荐」）不点击、直接归位到顶部；
 * 其余 tab 点击并等待列表变化。
 * 扫描不在本模块：由 preload `visual-collect` 的 scan 模式完成 —— 虚拟列表只保留约 200 张卡，
 * 必须边滚边记，放在页内才不会丢卡。
 */
export async function prepareRecommendTab(
  tab: RecommendTab,
  opts: { tabId?: string; isFirst?: boolean; waitMs?: number } = {}
): Promise<SwitchTabResult> {
  return switchRecommendTab(tab, {
    tabId: opts.tabId,
    // 第一个 tab 是页面默认选中的「推荐」，不点也能扫；点了也不会换列表，别白等 15s。
    expectChange: !opts.isFirst,
    waitMs: opts.waitMs,
  });
}
