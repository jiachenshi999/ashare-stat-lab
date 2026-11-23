/* 验证：数据未就绪 / 加载失败时，P2 卡片必须出现显式提示，而不是白板。
 * 做法：在 vm 里用桩 DOM + 记录型 echarts 跑 renderAll()，断言提示文本确实被写入。 */
const fs = require("fs");
const vm = require("vm");
const ROOT = "D:\\AgentsChat\\DeepSeekHarness\\Investment\\Ashare-Stat-Lab";
const code = fs.readFileSync(ROOT + "\\frontend\\app.js", "utf8");

const contentEl = { innerHTML: "" };
const calls = {}; // id -> 最近一次 setOption
const mkEl = (id) => ({ id, style: {}, classList: { toggle() {}, add() {}, remove() {} }, dataset: {} });

const sandbox = {
  window: { addEventListener() {} },
  document: {
    querySelector: (s) => (s === "#content" ? contentEl : mkEl(s)),
    querySelectorAll: () => [],
    getElementById: (id) => mkEl(id),
    addEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  },
  echarts: {
    init: (el) => {
      const id = el.id;
      return {
        dispose() {},
        setOption(opt) { calls[id] = opt; },
        getDataURL() { return ""; },
      };
    },
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  location: { hash: "" },
  history: { replaceState() {} },
  console, setTimeout, clearTimeout, Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  __DATA__: JSON.parse(fs.readFileSync(ROOT + "\\data\\processed\\stats\\sh000001.json", "utf8")),
  __VAL__: JSON.parse(fs.readFileSync(ROOT + "\\frontend\\data\\valuation.json", "utf8")),
  __DATA300__: JSON.parse(fs.readFileSync(ROOT + "\\data\\processed\\stats\\sh000300.json", "utf8")),
  __IND__: JSON.parse(fs.readFileSync(ROOT + "\\frontend\\data\\industry.json", "utf8")),
  __CONTENT__: contentEl,
  __CALLS__: calls,
  __RESULT__: "",
};
vm.createContext(sandbox);

const driver = [
  'INDICES = { sh000001: {name:"上证指数", market:"SSE", has_stats:true} };',
  'EVENTS = [];',
  'selectedKeys = ["sh000001"]; dataMap["sh000001"] = __DATA__; dataMap["sh000300"] = __DATA300__;',
  'currentData = dataMap["sh000001"]; currentKey = "sh000001"; range = "all";',
  'const out = [];',
  // 场景1：行业数据尚未加载（industry.json 还在路上）
  'INDUSTRY = null; VALUATION = __VAL__; industryLoadError = null; p2IndicesTried = true;',
  'activeModule = "p2value"; renderAll();',
  'out.push("S1 提示横幅: " + (/正在加载：[^]*行业/.test(__CONTENT__.innerHTML) ? "OK" : "MISSING"));',
  'out.push("S1 行业PE占位: " + (/行业数据尚未加载/.test(JSON.stringify(__CALLS__["p2-indpe"] || {})) ? "OK" : "MISSING"));',
  'out.push("S1 热力图占位: " + (/行业数据尚未加载/.test(JSON.stringify(__CALLS__["p2-indyear"] || {})) ? "OK" : "MISSING"));',
  // 场景2：加载失败
  'INDUSTRY = null; VALUATION = __VAL__; industryLoadError = "HTTP 500";',
  'activeModule = "p2value"; renderAll();',
  'out.push("S2 失败横幅: " + (/行业数据加载失败：[^]*HTTP 500/.test(__CONTENT__.innerHTML) ? "OK" : "MISSING"));',
  'out.push("S2 重试按钮: " + (/id="p2-retry"/.test(__CONTENT__.innerHTML) ? "OK" : "MISSING"));',
  // 场景3：数据齐全（不得出现任何占位/失败提示）
  'INDUSTRY = __IND__; VALUATION = __VAL__; industryLoadError = null;',
  'activeModule = "p2value"; renderAll();',
  'out.push("S3 无横幅: " + (/正在加载：|行业数据加载失败/.test(__CONTENT__.innerHTML) ? "LEAK" : "OK"));',
  'out.push("S3 行业PE有数据: " + ((__CALLS__["p2-indpe"] && __CALLS__["p2-indpe"].series && __CALLS__["p2-indpe"].series[0].data.length > 10) ? "OK" : "MISSING"));',
  'out.push("S3 超额热力图有数据: " + ((__CALLS__["p2-excess"] && __CALLS__["p2-excess"].series && __CALLS__["p2-excess"].series[0].data.length > 10) ? "OK" : "MISSING"));',
  '__RESULT__ = out.join("\\n");',
].join("\n");

vm.runInContext(code + "\n" + driver, sandbox);
console.log(sandbox.__RESULT__);
const fails = String(sandbox.__RESULT__).split("\n").filter((s) => s.includes("MISSING") || s.includes("LEAK"));
console.log(fails.length ? "\nRESULT: FAIL (" + fails.length + ")" : "\nRESULT: PASS");
process.exit(fails.length ? 1 : 0);

