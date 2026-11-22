/* 渲染检查：用 DOM/ECharts 桩运行全部模块（单对象+多对象），
 * 验证 (1) 无渲染异常 (2) 生成的 HTML 中没有泄漏的 "${" 字样。 */
const fs = require("fs");
const vm = require("vm");
const ROOT = "D:\\AgentsChat\\DeepSeekHarness\\Investment\\Ashare-Stat-Lab";
const code = fs.readFileSync(ROOT + "\\frontend\\app.js", "utf8");
const contentEl = { innerHTML: "" };
const fakeEl = () => ({ onchange: null, onclick: null, onkeydown: null, value: "", innerHTML: "", textContent: "", checked: false, style: {}, classList: { toggle() {}, add() {}, remove() {} } });
const fakeChart = () => ({ dispose() {}, setOption() {}, getDataURL() { return ""; } });
const sandbox = {
  window: { addEventListener() {} },
  document: {
    querySelector: (s) => (s === "#content" ? contentEl : fakeEl()),
    querySelectorAll: () => [],
    getElementById: (id) => ({ id, style: {} }),
    addEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  },
  echarts: { init: () => fakeChart() },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  location: { hash: "" },
  history: { replaceState() {} },
  console, setTimeout, clearTimeout, Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  __DATA__: JSON.parse(fs.readFileSync(ROOT + "\\data\\processed\\stats\\sh000001.json", "utf8")),
  __DATA2__: JSON.parse(fs.readFileSync(ROOT + "\\data\\processed\\stats\\sh000300.json", "utf8")),
  __CONTENT__: contentEl,
  __RESULT__: "",
};
vm.createContext(sandbox);
const driver = [
  'INDICES = { sh000001: {name:"上证指数", market:"SSE", has_stats:true}, sh000300: {name:"沪深300", market:"CSI", has_stats:true} };',
  'EVENTS = [{date:"2007-05-30", title:"印花税上调", cause:"测试原因"}];',
  'let results = [];',
  'function run(label, keys) {',
  '  selectedKeys = keys; dataMap["sh000001"] = __DATA__; dataMap["sh000300"] = __DATA2__;',
  '  currentData = dataMap[keys[0]]; currentKey = keys[0]; range = "all";',
  '  for (const m of ["overview","p01","p02","p03","p04"]) {',
  '    activeModule = m;',
  '    try { renderAll(); const h = __CONTENT__.innerHTML;',
  '      const leak = h.indexOf("$" + "{") >= 0;',
  '      const rerr = h.indexOf("渲染错误") >= 0;',
  '      const brief = rerr ? " | " + h.replace(/\\s+/g, " ").slice(0, 220) : "";',
  '      results.push(label + "/" + m + ": " + (rerr ? "RENDER_ERR" : leak ? "LEAK" : "ok") + " (len " + h.length + ")" + brief);',
  '    } catch (e) { results.push(label + "/" + m + ": ERR(" + e.message + ")"); }',
  '  }',
  '}',
  'run("single", ["sh000001"]);',
  'run("multi", ["sh000001", "sh000300"]);',
  '__RESULT__ = results.join("\\n");',
].join("\n");
vm.runInContext(code + "\n" + driver, sandbox);
console.log(sandbox.__RESULT__);
const fails = String(sandbox.__RESULT__).split("\n").filter(s => s.includes("LEAK") || s.includes("ERR"));
process.exit(fails.length ? 1 : 0);
