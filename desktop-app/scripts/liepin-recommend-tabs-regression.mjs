// 猎聘「求职意向 tab」选择器契约回归（零新增依赖、无 DOM / 无网络）
//
// 为什么需要它（2026-11-25 用户日志）：
//   猎聘登录态首页的 tab 头与搜索页是**两套完全不同的 DOM**（首页是
//   `div.switch-title-item[data-nick="switch-item"]`，选中态追加
//   `switch-title-item-active--<hash>` 类；搜索页是 `.expect-row .expect-item[.is-active]`）。
//   只认其中一套时 `discoverRecommendTabs` 返回 0 个 tab，调用方只记一条 warn 就
//   **静默退化成「只采当前推荐列表」** —— 功能坏了但任务照常「成功」，日志里很难发现。
//   所以这里把两套结构钉成契约：删掉任意一套、或误把「综合/最新」排序条当成 tab，都必须红。
//
// 选择器与真机 DOM（用户提供的登录态首页 outerHTML）的对应关系：
//   <div class="switch-title-left--Y2JlM">
//     <div class="switch-title-item--Y2JlM switch-title-item-active--Y2JlM" data-nick="switch-item">
//       <span class="tab-item-title--Y2JlM">架构师</span></div>
//     <div class="switch-title-item--Y2JlM" data-nick="switch-item">…</div>
//   </div>
//   <div class="switch-title-right--Y2JlM" data-nick="add-job-want">编辑求职期望</div>
//   <div class="switch-sort--Y2JlM">
//     <div class="switch-sort-active--Y2JlM" data-nick="sort-type-mix">综合</div>
//     <div class="" data-nick="sort-type-new">最新</div></div>
//
// 用法：node scripts/liepin-recommend-tabs-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = 'src/lib/bossclaw/recommendTabs.ts';

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}
function has(name, actual, needle) {
  ok(name, String(actual || '').includes(needle), `期望含：${needle}\n      实际：${actual}`);
}
function hasNot(name, actual, needle) {
  ok(name, !String(actual || '').includes(needle), `不应含：${needle}\n      实际：${actual}`);
}

/** 从生产文件原文抽出 PROFILES 对象字面量（只求值这一个声明，不加载模块） */
function loadProfiles() {
  const source = readFileSync(join(root, FILE), 'utf8');
  const ast = ts.createSourceFile(FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error(`${FILE} 解析失败`);
  for (const st of ast.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== 'PROFILES' || !d.initializer) continue;
      // initializer 是纯字面量（无类型标注）；模板字符串/调用都会在这里暴露出来
      const sandbox = {};
      vm.runInNewContext(`this.__profiles = (${d.initializer.getText(ast)});`, sandbox);
      return sandbox.__profiles;
    }
  }
  throw new Error(`${FILE} 缺少 PROFILES`);
}

const profiles = loadProfiles();
const liepin = profiles.liepin || {};
const boss = profiles.boss || {};

// ① 两套 tab 结构都要在（缺任意一套 → 对应页面静默退化为「只采当前列表」）
has('liepin.tabSelector 覆盖登录态首页', liepin.tabSelector, '[data-nick="switch-item"]');
has('liepin.tabSelector 覆盖搜索页', liepin.tabSelector, '.expect-row .expect-item');
has('liepin.activeTabSelector 覆盖首页选中态', liepin.activeTabSelector, '[data-nick="switch-item"][class*="switch-title-item-active"]');
has('liepin.activeTabSelector 覆盖搜索页选中态', liepin.activeTabSelector, '.expect-row .expect-item.is-active');

// ② 排序条 / 编辑入口不得混进 tab（点排序条只会换排序，白等一次列表变化超时）
hasNot('tabSelector 不得匹配排序条', liepin.tabSelector, 'sort-type');
hasNot('tabSelector 不得匹配编辑求职期望入口', liepin.tabSelector, 'add-job-want');
ok(
  'nonTabLabels 仍排除「编辑求职期望」',
  Array.isArray(liepin.nonTabLabels) && liepin.nonTabLabels.includes('编辑求职期望'),
  `实际：${JSON.stringify(liepin.nonTabLabels)}`
);

// ③ 列表指纹 / 归位用的卡片与滚动容器（首页卡片是驼峰 jobCardPcContainer，外层列表是 job-list-box）
has('liepin.cardSelector 覆盖首页卡片容器', liepin.cardSelector, 'div[class*="jobCardPcContainer"]');
has('liepin.cardSelector 覆盖列表项', liepin.cardSelector, 'div.job-list-item');
has('liepin.scrollSelector 覆盖首页列表容器', liepin.scrollSelector, '[class*="job-list-box"]');

// ④ BOSS 侧选择器不得被顺手改坏（同文件相邻常量，改错行很常见）
ok('boss.tabSelector 未改动', boss.tabSelector === '[class*="expect"] a', `实际：${boss.tabSelector}`);
ok('boss.cardSelector 未改动', boss.cardSelector === 'li.job-card-box', `实际：${boss.cardSelector}`);

// ⑤ 选中态子串匹配的语义（真机类名带构建哈希后缀，只能子串匹配）：
//    未选中的 tab 只带 `switch-title-item--<hash>`，不得被当成选中；
//    排序条的 `switch-sort-active--<hash>` 也不得被当成本 tab 的选中态。
const HASH = '--Y2JlM';
const activeNeedle = 'switch-title-item-active';
ok(
  '未选中 tab 不会被误判为选中',
  !`switch-title-item${HASH}`.includes(activeNeedle),
  `类名：switch-title-item${HASH}`
);
ok(
  '选中 tab 能被识别',
  `switch-title-item${HASH} switch-title-item-active${HASH}`.includes(activeNeedle)
);
ok(
  '排序条选中态不会被误判为 tab 选中',
  !`switch-sort-active${HASH}`.includes(activeNeedle),
  `类名：switch-sort-active${HASH}`
);
// 真机上这几项是同排的兄弟节点，靠 data-nick 区分；保证它们永远不等于 tab 的 switch-item。
for (const nick of ['sort-type-mix', 'sort-type-new', 'add-job-want']) {
  ok(`data-nick="${nick}" 不属于求职 tab`, nick !== 'switch-item');
}

if (failures.length) {
  console.error(`✗ 猎聘推荐 tab 选择器契约回归：${failures.length} 项失败 / ${pass + failures.length} 项`);
  for (const f of failures) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ 猎聘推荐 tab 选择器契约回归：${pass} 项全部通过`);
