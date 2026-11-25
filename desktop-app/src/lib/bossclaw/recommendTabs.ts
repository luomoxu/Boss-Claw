// 推荐页「求职意向 tab」发现 / 切换（BOSS / 猎聘）
// ---------------------------------------------------------------------------
// 背景：BOSS `/web/geek/jobs`（不带 query）与猎聘 `/zhaopin/`（不带 key）都会按账号内的
// 「求职意向 / 求职期望」生成推荐列表，页内各意向是一个 tab：
//   BOSS：`推荐 / 技术经理(成都) / 架构师(成都) / 技术总监(成都) …`
//   猎聘（两套结构，见下方 PROFILES.liepin）：
//     · 搜索页 `.expect-row` 内的 `button.expect-item`
//     · 登录态首页 `div.switch-title-item[data-nick="switch-item"]`（顶部 tab 头）
// **切 tab 是 SPA 状态，URL 不变**，所以只能靠点击切换，不能拼 URL 直达。
//
// 为什么不走推荐接口：站方的推荐 API 属于强风控面（且不在白名单内），本模块只通过
// `getBrowser().uiExec` 做「查询可见 tab → 点击 → 等列表变化」这类等价于人工点击的操作。
//
// 失败口径：发现失败 / 点击失败 / 等不到列表变化，都**不抛异常**，由调用方降级
// （发现失败 → 只采当前列表；切换超时 → 仍按当前列表继续扫，只是记一条 warn）。
import { getBrowser } from '../browserRegistry';
import type { JobPlatform } from './types';

/** 支持「求职意向 tab」采集的平台（其余平台没有这套页面结构） */
export type RecommendTabPlatform = Extract<JobPlatform, 'boss' | 'liepin'>;

interface RecommendTabProfile {
  /** tab 元素选择器 */
  tabSelector: string;
  /** 当前选中 tab 的选择器；能读到即认为「活动 tab 已知」（用于避免重复点击当前 tab） */
  activeTabSelector?: string;
  /** 列表首屏指纹用的卡片选择器 */
  cardSelector: string;
  /** 在 tab 容器附近、但并不是推荐 tab 的文案 */
  nonTabLabels: string[];
  /** 「回到列表顶部」的滚动目标；BOSS 虚拟列表挂 window，猎聘新版是内部滚动容器 */
  scrollSelector: string;
}

/**
 * 平台差异表。
 *
 * 猎聘搜索页选择器来源（非猜测）：官方 `search-jobs-v2` 前端 bundle 的求职期望组件为
 *   `<div class="expect-row"><button class="expect-item [is-active]" title="期望名">期望名</button>
 *    … <a class="expect-edit">编辑求职期望</a></div>`
 * 列表容器是 `#lp-search-job-list.job-list-box`（页面自己拦截 wheel 改它的 scrollTop），
 * 卡片是 `div.job-list-item > div.job-card-pc-container`（新版）/ `div.jobCardPcContainer`（旧版）。
 * 登录态首页结构见 `PROFILES.liepin.tabSelector` 注释（2026-11-25 用户真机 outerHTML）。
 */
const PROFILES: Record<RecommendTabPlatform, RecommendTabProfile> = {
  boss: {
    tabSelector: '[class*="expect"] a',
    cardSelector: 'li.job-card-box',
    nonTabLabels: ['地图', '搜索'],
    scrollSelector: 'html',
  },
  liepin: {
    // 猎聘有**两套**求职意向 tab 结构，必须同时覆盖（只认其中一套会静默退化成「只采当前列表」）：
    //   ① 搜索页 search-jobs-v2：`.expect-row` 内 `button.expect-item`，选中态 `.is-active`
    //   ② 登录态首页（2026-11-25 用户真机 outerHTML）：
    //        <div class="switch-title-left--xxxx">
    //          <div class="switch-title-item--xxxx switch-title-item-active--xxxx" data-nick="switch-item">
    //            <span class="tab-item-title--xxxx">架构师</span></div> …
    //          <div class="switch-title-right--xxxx" data-nick="add-job-want">编辑求职期望</div>
    //        </div>
    //        <div class="switch-sort--xxxx">
    //          <div class="switch-sort-active--xxxx" data-nick="sort-type-mix">综合</div>
    //          <div class="" data-nick="sort-type-new">最新</div></div>
    //      ⚠️ 只能按 `data-nick="switch-item"` 认 tab：同一行里「综合 / 最新」是**排序**，
    //      不是求职意向；「编辑求职期望」是入口按钮。用 `[class*="switch-title-item"]` 会把
    //      它们一并当成 tab（点排序条只会换排序，白等一次列表变化超时）。data-nick 是站点埋点
    //      属性，哈希类名（--xxxx 后缀）每次构建都会变，不能写死。
    //      选中态是**追加**一个 `switch-title-item-active--xxxx` 类，同样只能子串匹配。
    tabSelector: '[data-nick="switch-item"], .expect-row .expect-item',
    // 读不到就按「未知」处理（调用方把第一个 tab 当默认选中）。
    activeTabSelector: '[data-nick="switch-item"][class*="switch-title-item-active"], .expect-row .expect-item.is-active',
    cardSelector: 'div.job-list-item, div[class*="job-card-pc-container"], div[class*="jobCardPcContainer"]',
    nonTabLabels: ['编辑求职期望'],
    // 首页（无关键字采集入口）没有内部列表滚动容器，整页由 window 滚动：
    // 末尾的 `html` 是兜底目标，搜索页仍会先命中 `#lp-search-job-list`。
    scrollSelector: '#lp-search-job-list, [class*="job-list-box"], html',
  },
};

const TAB_POLL_INTERVAL_MS = 600;

// 猎聘登录态首页的 `switch-box` 是登录信息就绪后**异步挂载**的（首屏先出 SEO 模块），
// 页面刚打开就查一次很容易 0 命中、被误判成「没有 tab」而退化成只采当前列表。
// 有限次轮询兜住这段渲染窗口；查询本身有超时，不会无限等。
const TAB_DISCOVER_ATTEMPTS = 3;
const TAB_DISCOVER_INTERVAL_MS = 1000;

function profileFor(platform: RecommendTabPlatform | undefined): RecommendTabProfile | null {
  return PROFILES[platform ?? 'boss'] ?? null;
}

export interface RecommendTab {
  label: string;
  /** 发现顺序（BOSS 0 一般是「推荐」；猎聘顺序与账号内求职期望顺序一致） */
  index: number;
  /** 是否为页面当前选中的 tab（仅部分平台可读到） */
  active?: boolean;
}

export interface DiscoverTabsResult {
  tabs: RecommendTab[];
  /** 是否读到了页面当前选中态（false 时调用方按「第一个 tab 默认选中」处理） */
  activeKnown: boolean;
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

/** 首次 0 命中时做有限轮询（见 TAB_DISCOVER_ATTEMPTS 注释）；真正查询失败立即返回。 */
async function queryTabTextsWithPoll(
  selector: string,
  limit: number,
  tabId?: string,
  timeoutMs = 8000
): Promise<{ texts: string[]; error?: string }> {
  let last: { texts: string[]; error?: string } = { texts: [] };
  for (let attempt = 0; attempt < TAB_DISCOVER_ATTEMPTS; attempt += 1) {
    last = await queryTexts(selector, limit, tabId, timeoutMs);
    if (last.error) return last;
    if (last.texts.some(Boolean)) return last;
    if (attempt < TAB_DISCOVER_ATTEMPTS - 1) await sleep(TAB_DISCOVER_INTERVAL_MS);
  }
  return last;
}

/** 发现推荐 tab（按页面顺序，已过滤噪声文案与重复项）。 */
export async function discoverRecommendTabs(
  opts: { platform?: RecommendTabPlatform; tabId?: string; timeoutMs?: number } = {}
): Promise<DiscoverTabsResult> {
  const profile = profileFor(opts.platform);
  if (!profile) return { tabs: [], activeKnown: false, error: '该平台不支持推荐 tab 采集' };
  const { texts, error } = await queryTabTextsWithPoll(profile.tabSelector, 40, opts.tabId, opts.timeoutMs ?? 8000);
  if (error) return { tabs: [], activeKnown: false, error };
  const excluded = new Set(profile.nonTabLabels);
  const seen = new Set<string>();
  const tabs: RecommendTab[] = [];
  for (const text of texts) {
    if (!text || text.length > 30) continue;
    if (excluded.has(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    tabs.push({ label: text, index: tabs.length });
  }
  if (!tabs.length) {
    return { tabs: [], activeKnown: false, error: `未在页面找到推荐 tab（选择器无命中，已轮询 ${TAB_DISCOVER_ATTEMPTS} 次）` };
  }

  // 选中态：读得到就标注，避免把「已经是当前 tab」再点一次白等一个超时。
  let activeKnown = false;
  if (profile.activeTabSelector) {
    const act = await queryTexts(profile.activeTabSelector, 5, opts.tabId, 5000);
    const activeLabel = act.texts.find(Boolean);
    const target = activeLabel ? tabs.find((t) => t.label === activeLabel) : undefined;
    if (target) {
      target.active = true;
      activeKnown = true;
    }
  }
  return { tabs, activeKnown };
}

/** 列表首屏采样张数（用于判断「点了 tab 之后列表是否换了」） */
const FINGERPRINT_CARDS = 10;

interface ListFingerprint {
  texts: string[];
}

async function listFingerprint(tabId?: string, platform?: RecommendTabPlatform): Promise<ListFingerprint> {
  const profile = profileFor(platform);
  if (!profile) return { texts: [] };
  const { texts } = await queryTexts(profile.cardSelector, FINGERPRINT_CARDS, tabId, 6000);
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
export async function scrollListToTop(tabId?: string, platform?: RecommendTabPlatform): Promise<void> {
  const b = getBrowser();
  if (!b) return;
  const profile = profileFor(platform);
  try {
    // 实测：`to:'bottom'` 走 scrollIntoView，对 BOSS 本页无效；必须用 dy 才有滚动效果。
    // 猎聘新版列表是内部滚动容器（window 不可滚），必须滚 `.job-list-box` 本身。
    await b.uiExec('scroll', { selector: profile?.scrollSelector || 'html', dy: -200000 }, 6000, tabId);
  } catch {
    /* 滚动失败不影响后续扫描（scan 自己也会滚） */
  }
  if ((profile?.scrollSelector || 'html') === 'html') return; // BOSS 已经在上面滚过 document，别重复调用
  try {
    // 猎聘**登录态首页**恰好相反：列表容器不可滚、整页由 window 滚动，上面那次 scrollBy
    // 落在 `.job-list-box` 上是空操作。补一次 document 归位；搜索页上这是无副作用的多余调用。
    await b.uiExec('scroll', { selector: 'html', dy: -200000 }, 6000, tabId);
  } catch {
    /* 同上 */
  }
}

/**
 * 切到指定 tab。
 *
 * @param tab           discoverRecommendTabs 的结果
 * @param opts.skipClick 该 tab 已是页面当前选中项：不点击，只把列表滚回顶部
 * @param opts.waitMs   等列表变化的超时（默认 15s）
 */
export async function switchRecommendTab(
  tab: RecommendTab,
  opts: { platform?: RecommendTabPlatform; tabId?: string; skipClick?: boolean; waitMs?: number } = {}
): Promise<SwitchTabResult> {
  const { tabId, waitMs = 15000, platform } = opts;
  const profile = profileFor(platform);
  if (!profile) return { ok: false, switched: false, clicked: false, error: '该平台不支持推荐 tab 采集' };
  const b = getBrowser();
  if (!b) return { ok: false, switched: false, clicked: false, error: '浏览器未就绪' };

  // 基线必须在「列表顶部」采样（见下方说明）；当前 tab 不用点击时也顺手归位
  await scrollListToTop(tabId, platform);
  // 已是当前选中 tab（BOSS 默认「推荐」/ 猎聘 is-active）：不点击，直接扫当前列表
  if (opts.skipClick) return { ok: true, switched: true, clicked: false };

  let before = await listFingerprint(tabId, platform);
  let clicked = false;
  let lastDelta = { changed: false, overlap: before.texts.length, compared: before.texts.length };

  // 最多点两次：首击可能被骨架屏 / 过渡遮罩吞掉（点击成功但列表没动），
  // 再点一次的成本远低于漏掉整个 tab 的岗位。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await sleep(1200);
      await scrollListToTop(tabId, platform);
      // 以「重试点击前」的列表为新基线：首击后列表可能已经部分更新
      before = await listFingerprint(tabId, platform);
    }
    try {
      const res = await b.uiExec('click', { selector: profile.tabSelector, label: tab.label, index: 0 }, 8000, tabId);
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

    await scrollListToTop(tabId, platform);

    // 轮询到「列表首屏指纹变化 / 超时」。切 tab 后是异步拉列表，没有可用的同步信号，
    // 只能以列表内容的事实变化为准（见 fingerprintDelta：重叠 2/3 以内即认可切换）。
    // 注意 before 已在滚动到顶部之后采样：上一阶段（详情采集）结束时列表停在底部，
    // 若在底部采样，会被「滚回顶部」本身误判成「tab 已切换」。
    const wait = attempt === 0 ? waitMs : 10000;
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      await sleep(TAB_POLL_INTERVAL_MS);
      const now = await listFingerprint(tabId, platform);
      lastDelta = fingerprintDelta(before, now);
      if (lastDelta.changed) {
        await scrollListToTop(tabId, platform);
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
 * 供 Workbench 调用的切 tab 入口：当前选中的 tab 不点击、直接归位到顶部；
 * 其余 tab 点击并等待列表变化。
 * 扫描不在本模块：由 preload `visual-collect` 的 scan 模式完成 —— 虚拟列表只保留约 200 张卡，
 * 必须边滚边记，放在页内才不会丢卡。
 */
export async function prepareRecommendTab(
  tab: RecommendTab,
  opts: { platform?: RecommendTabPlatform; tabId?: string; skipClick?: boolean; waitMs?: number } = {}
): Promise<SwitchTabResult> {
  return switchRecommendTab(tab, {
    platform: opts.platform,
    tabId: opts.tabId,
    // 已确认是当前 tab（猎聘 is-active）或调用方判定默认选中（BOSS 第一个 tab）→ 不点，
    // 点了也不会换列表，别白等 15s。
    skipClick: opts.skipClick === true || tab.active === true,
    waitMs: opts.waitMs,
  });
}
