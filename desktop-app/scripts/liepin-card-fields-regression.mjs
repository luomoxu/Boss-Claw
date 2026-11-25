// 猎聘列表卡「【城市】」字段提取回归（零新增依赖、无 DOM / 无网络）
//
// 为什么需要它（2026-11-25 用户日志）：
//   登录态首页推荐卡的模板把城市并进标题，并把括号拆成独立 span；宽泛的地点选择器
//   （[class*="dq"] / [class*="area"]）会先命中只含「【」的那个 span，于是岗位地点被写成「【」：
//     跳过「首席工程负责人 【 成都 】」（硬拦截：岗位地点「【」不在目标城市（成都））
//   根因不是选择器少，而是「取到脏值后不再校验」—— 归一化后只剩括号/标点的命中值必须作废、
//   继续尝试下一个候选，否则下游 jobMatch 的「目标城市」硬约束会把整批岗位误拦。
//
// 本脚本从**生产文件原文**抽声明（AST，避免复制粘贴漂移），守住两条纯逻辑契约：
//   ① 地点候选归一：脏值作废（''），「【 成都 】」→「成都」，「【成都-青羊区】」→「成都-青羊区」；
//   ② 标题清理：只剥离「像地点」的【…】片段，「【急聘】」这类标题角标保持原样。
// 同时断言 webview.cjs 与 cloakCollector.cjs 两处搬运实现口径一致（改了一处忘另一处会红）。
//
// 用法：node scripts/liepin-card-fields-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望：${e}\n      实际：${a}`);
}

/**
 * 从生产文件里抽出「函数/常量声明」并只求值所需的依赖闭包。
 * 不进入普通函数体（避免把局部变量当全局声明），但会进入 IIFE 体
 * （cloakCollector.cjs 的整段页面脚本包在 (function(){ … })() 里）。
 */
function loadHelpers(file) {
  const source = readFileSync(join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`${file} 解析失败`);

  const decls = new Map(); // name -> 原文片段
  const collectFrom = (statements) => {
    for (const st of statements) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        decls.set(st.name.text, st.getText(ast));
        continue;
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) decls.set(d.name.text, d.getText(ast));
        }
        continue;
      }
      // 只下钻 IIFE 体：其余语句里的函数表达式属于运行时局部作用域
      if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
        let fn = st.expression.expression;
        while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
        if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) {
          collectFrom(ts.isBlock(fn.body) ? fn.body.statements : []);
        }
      }
    }
  };
  collectFrom(ast.statements);

  const wanted = new Set();
  const resolve = (name) => {
    if (wanted.has(name)) return;
    const text = decls.get(name);
    if (text == null) throw new Error(`${file} 缺少声明 ${name}`);
    wanted.add(name);
    for (const other of decls.keys()) {
      if (other !== name && new RegExp(`\\b${other}\\b`).test(text)) resolve(other);
    }
  };
  resolve('normalizeLocationText');
  resolve('normalizeLocationCandidate');
  resolve('cleanJobTitle');

  const code = [...wanted].map((n) => decls.get(n)).join('\n');
  const sandbox = {};
  vm.runInNewContext(`${code}\nthis.__helpers = { normalizeLocationText, normalizeLocationCandidate, cleanJobTitle };`, sandbox);
  return sandbox.__helpers;
}

const CASES = [
  // [函数, 输入, 期望]
  // 选择器命中值：只去括号/空白 —— 脏值作废，但未收录城市（如「扬州」）必须保留
  ['normalizeLocationText', '【', ''],
  ['normalizeLocationText', '【】', ''],
  ['normalizeLocationText', '   ', ''],
  ['normalizeLocationText', '【 成都 】', '成都'],
  ['normalizeLocationText', '扬州', '扬州'],
  // 括号兜底：必须是地点形态，标题角标不放行
  ['normalizeLocationCandidate', '【', ''],
  ['normalizeLocationCandidate', '【 成都 】', '成都'],
  ['normalizeLocationCandidate', '【成都-青羊区】', '成都-青羊区'],
  ['normalizeLocationCandidate', '成都-青羊区', '成都-青羊区'],
  ['normalizeLocationCandidate', '深圳·南山区·科技园', '深圳·南山区·科技园'],
  ['normalizeLocationCandidate', '远程', '远程'],
  ['normalizeLocationCandidate', '急聘', ''],
  ['normalizeLocationCandidate', '首席工程负责人', ''],
  // 标题清理
  ['cleanJobTitle', '首席工程负责人 【 成都 】', '首席工程负责人'],
  ['cleanJobTitle', 'Agent 技术架构师 【 成都-青羊区 】', 'Agent 技术架构师'],
  ['cleanJobTitle', '【成都】Java开发', 'Java开发'],
  ['cleanJobTitle', 'Java开发【急聘】', 'Java开发【急聘】'],
  ['cleanJobTitle', '产品经理 【', '产品经理'],
  ['cleanJobTitle', '', ''],
];

for (const file of ['electron/preload/webview.cjs', 'electron/cloakbrowser/cloakCollector.cjs']) {
  const helpers = loadHelpers(file);
  for (const [fn, input, expected] of CASES) {
    eq(`${file} :: ${fn}(${JSON.stringify(input)})`, helpers[fn](input), expected);
  }
}

if (failures.length) {
  console.error(`✗ 猎聘卡片字段回归：${failures.length} 项失败 / ${pass + failures.length} 项`);
  for (const f of failures) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ 猎聘卡片字段回归：${pass} 项全部通过`);
