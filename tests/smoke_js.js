/* Node 冒烟测试：加载 app.js 的纯统计函数，与后端 Python 结果及人工样例交叉核对。 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = "D:\\AgentsChat\\DeepSeekHarness\\Investment\\Ashare-Stat-Lab";
const code = fs.readFileSync(path.join(ROOT, "frontend", "app.js"), "utf8");

const noop = () => {};
const sandbox = {
  window: { addEventListener: noop },
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: noop,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  },
  echarts: { init: () => ({ dispose() {}, setOption() {}, getDataURL() { return ""; } }) },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  console,
  setTimeout, clearTimeout, Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "app.js" });

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}
function close(a, b, msg, eps = 1e-6) {
  ok(Math.abs(a - b) <= eps, `${msg} (${a} vs ${b})`);
}
function closeArr(a, b, msg, eps = 1e-6) {
  ok(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= eps), `${msg} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
}

console.log("== 人工样例（与 Python 测试一致） ==");
closeArr(sandbox.dailyReturnsPct([100, 90, 80, 100, 110]), [-10, (80 / 90 - 1) * 100, 25, 10], "dailyReturnsPct");
close(sandbox.quantile(sandbox.sortedCopy([1, 2, 3, 4]), 50), 2.5, "quantile 线性插值");
close(sandbox.sampleStd([1, 2, 3, 4]), 1.2909944487358056, "sampleStd ddof=1");
close(sandbox.sampleSkew([-2, -1, 0, 1, 2]), 0, "sampleSkew 对称");
{
  const e = sandbox.ecdf([-3, -1, 0, 1, 2]);
  // F(-1)=40
  const idx = e.x.indexOf(-1);
  close(e.y[idx], 40, "ECDF F(-1)=40%");
}
{
  const t = sandbox.tailFreq([-3, -1, 0, 1, 2], 2);
  close(t.p_abs_ge_pct, 40, "P(|R|>=2)=40%");
  close(t.p_le_neg_pct, 20, "P(R<=-2)=20%");
}
{
  const evs = sandbox.drawdownEvents([100, 90, 80, 100, 110], ["d0", "d1", "d2", "d3", "d4"]);
  ok(evs.length === 1, "drawdown 1 事件");
  close(evs[0].max_drawdown, -0.2, "max_drawdown -20%");
  ok(evs[0].recovered === true && evs[0].recovery_date === "d3", "recovery d3");
}
{
  const evs = sandbox.drawdownEvents([100, 90, 80, 85], ["d0", "d1", "d2", "d3"]);
  ok(evs.length === 1 && evs[0].recovered === false && evs[0].recovery_date === null, "drawdown 右删失");
}
{
  const h = sandbox.holdingReturns([100, 110, 121], 1);
  close(h.n, 2, "holding n=2");
  close(h.win_rate_pct, 100, "holding win 100%");
  closeArr(h.returns_pct, [10, 10], "holding returns");
}

console.log("== 真实数据：前端 JS vs 后端 Python 摘要 ==");
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "processed", "stats", "sh000001.json"), "utf8"));
const jsSummary = sandbox.summaryStats(stats.returns_pct);
const pySummary = stats.summary;
close(jsSummary.n, pySummary.n, "N");
close(jsSummary.mean_pct, pySummary.mean_pct, "mean", 1e-4);
close(jsSummary.median_pct, pySummary.median_pct, "median", 1e-4);
close(jsSummary.std_pct, pySummary.std_pct, "std", 1e-4);
close(jsSummary.annualized_vol_pct, pySummary.annualized_vol_pct, "annualized vol", 1e-3);
close(jsSummary.p1, pySummary.p1, "p1", 1e-3);
close(jsSummary.p99, pySummary.p99, "p99", 1e-3);
close(jsSummary.skewness, pySummary.skewness, "skew", 1e-4);
close(jsSummary.excess_kurtosis, pySummary.excess_kurtosis, "excess kurtosis", 1e-3);

const jsEvents = sandbox.drawdownEvents(stats.close, stats.dates);
const jsDeep = jsEvents.filter(e => e.max_drawdown <= -0.05).length;
const pyDeep = stats.drawdown_events.filter(e => e.max_drawdown <= -0.05).length;
ok(jsEvents.length === stats.drawdown_events.length, `drawdown 事件数 JS=${jsEvents.length} PY=${stats.drawdown_events.length}`);
ok(jsDeep === pyDeep, `深回撤(≤-5%) JS=${jsDeep} PY=${pyDeep}`);

console.log(`\n结果: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
