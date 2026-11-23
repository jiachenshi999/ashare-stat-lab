/* A股市场统计认知实验室 —— 前端逻辑
 * 统计口径与 backend/analytics.py 完全一致（见 docs/STATISTICAL_METHODS.md）。
 * 全样本数据一次载入，日期/阈值/分箱等交互均在客户端即时重算。
 */
"use strict";

const UP = "#d64541", DOWN = "#1a9e6c";
const CHART_IDS = new Set();

// ---------------- 状态 ----------------
let INDICES = null;
let selectedKeys = ["sh000001"];   // 多选研究对象（顺序=优先级，第一个为主研究对象）
const dataMap = {};                 // key -> 已加载的 stats JSON
let currentKey = "sh000001";
let currentData = null;
let range = "all";
let customStart = null, customEnd = null;
let binWidth = 0.5;         // P0-1 直方图 bin 宽度（百分点）
let showKde = true, showNormal = true;
let holdingHorizon = 250;   // P0-4 当前持有期
let logScale = false;       // P0-3 对数轴
let selectedDate = null;    // 被点选定位的历史交易日
let EVENTS = null;          // 历史事件库（极端日原因）
let MARKET = null;          // P1 最新截面（广度+规模）
let LIQUIDITY = null;       // P1-7 指数成交额历史
let VALUATION = null;       // P2-8 指数 PE 历史
let INDUSTRY = null;        // P2-9 申万行业

const PALETTE = ["#2563eb", "#d64541", "#1a9e6c", "#7c3aed", "#b45309", "#0891b2", "#be185d", "#4d7c0f"];
const charts = {};

// ---------------- 工具 ----------------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function fmt(x, d = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return Number(x).toFixed(d);
}
function fmtPct(x, d = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return Number(x).toFixed(d) + "%";
}
function shiftDate(dateStr, years) {
  const d = new Date(dateStr + "T00:00:00");
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

// ---------------- 统计函数（镜像 backend/analytics.py） ----------------
function dailyReturnsPct(close) {
  const r = [];
  for (let i = 1; i < close.length; i++) r.push((close[i] / close[i - 1] - 1) * 100);
  return r;
}
function mean(v) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }
function sampleStd(v) {
  const n = v.length;
  if (n < 2) return NaN;
  const m = mean(v);
  let s = 0;
  for (const x of v) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}
function sortedCopy(v) { return v.slice().sort((a, b) => a - b); }
function quantile(sorted, q) { // q in [0,100]，线性插值
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
}
function sampleSkew(v) {
  const n = v.length;
  if (n < 3) return NaN;
  const m = mean(v);
  let m2 = 0, m3 = 0;
  for (const x of v) { const d = x - m; m2 += d * d; m3 += d * d * d; }
  m2 /= n; m3 /= n;
  if (m2 <= 0) return NaN;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * (m3 / Math.pow(m2, 1.5));
}
function sampleExKurt(v) {
  const n = v.length;
  if (n < 4) return NaN;
  const m = mean(v);
  let m2 = 0, m4 = 0;
  for (const x of v) { const d = x - m; const d2 = d * d; m2 += d2; m4 += d2 * d2; }
  m2 /= n; m4 /= n;
  if (m2 <= 0) return NaN;
  const g2 = m4 / (m2 * m2) - 3;
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6);
}
function summaryStats(ret) {
  const n = ret.length;
  if (!n) return { n: 0 };
  const s = sortedCopy(ret);
  const stdPct = sampleStd(ret);
  return {
    n,
    mean_pct: mean(ret),
    median_pct: quantile(s, 50),
    std_pct: stdPct,
    annualized_vol_pct: sampleStd(ret.map(x => x / 100)) * Math.sqrt(252) * 100,
    positive_days_pct: mean(ret.map(x => x > 0 ? 1 : 0)) * 100,
    negative_days_pct: mean(ret.map(x => x < 0 ? 1 : 0)) * 100,
    zero_days_pct: mean(ret.map(x => x === 0 ? 1 : 0)) * 100,
    min_pct: Math.min(...ret), max_pct: Math.max(...ret),
    skewness: sampleSkew(ret), excess_kurtosis: sampleExKurt(ret),
    p1: quantile(s, 1), p5: quantile(s, 5), p25: quantile(s, 25),
    p50: quantile(s, 50), p75: quantile(s, 75), p95: quantile(s, 95), p99: quantile(s, 99),
  };
}
function histogram(ret, binWidth) {
  const n = ret.length;
  if (!n) return { bins: [], density: [], counts: [], centers: [] };
  let lo = Math.min(...ret), hi = Math.max(...ret);
  const nbins = Math.ceil((hi - lo) / binWidth);
  hi = lo + nbins * binWidth;
  const edges = [], centers = [], counts = new Array(nbins).fill(0);
  for (let i = 0; i <= nbins; i++) edges.push(lo + i * binWidth);
  for (let i = 0; i < nbins; i++) centers.push((edges[i] + edges[i + 1]) / 2);
  for (const x of ret) {
    let b = Math.floor((x - lo) / binWidth);
    if (b >= nbins) b = nbins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const density = counts.map(c => c / (n * binWidth));
  return { bins: edges, centers, counts, density };
}
function gaussianKde(ret, nPoints = 512) {
  const n = ret.length;
  if (!n) return { x: [], y: [], bandwidth: 0 };
  let std = sampleStd(ret);
  if (!isFinite(std) || std === 0) std = Math.sqrt(mean(ret.map(x => x * x)));
  if (std === 0) std = 1e-9;
  const bw = 1.06 * std * Math.pow(n, -1 / 5);
  const lo = Math.min(...ret) - 3 * bw, hi = Math.max(...ret) + 3 * bw;
  const x = [], y = [];
  for (let i = 0; i < nPoints; i++) {
    const xi = lo + (hi - lo) * i / (nPoints - 1);
    let s = 0;
    for (const v of ret) { const d = (xi - v) / bw; s += Math.exp(-0.5 * d * d); }
    x.push(xi);
    y.push(s / (n * bw * Math.sqrt(2 * Math.PI)));
  }
  return { x, y, bandwidth: bw };
}
function normalPdf(xArr, m, std) {
  if (std <= 0) return xArr.map(() => 0);
  return xArr.map(x => Math.exp(-0.5 * Math.pow((x - m) / std, 2)) / (std * Math.sqrt(2 * Math.PI)));
}
function ecdf(ret) {
  const s = sortedCopy(ret);
  const n = s.length;
  const y = s.map((_, i) => (i + 1) / n * 100);
  return { x: s, y, n };
}
function tailFreq(ret, a) {
  const n = ret.length;
  let leNeg = 0, gePos = 0, absGe = 0;
  for (const r of ret) {
    if (r <= -a) leNeg++;
    if (r >= a) gePos++;
    if (Math.abs(r) >= a) absGe++;
  }
  return {
    threshold: a, p_le_neg_pct: leNeg / n * 100, p_ge_pos_pct: gePos / n * 100,
    p_abs_ge_pct: absGe / n * 100, count_le_neg: leNeg, count_ge_pos: gePos, count_abs_ge: absGe, n
  };
}
function drawdownEvents(close, dates) {
  const n = close.length;
  if (!n) return [];
  const cm = [], dd = [];
  let m = -Infinity;
  for (let i = 0; i < n; i++) { m = Math.max(m, close[i]); cm.push(m); dd.push(close[i] / m - 1); }
  const eps = 1e-12, events = [];
  let i = 0;
  while (i < n) {
    if (dd[i] >= -eps) { i++; continue; }
    const peakIdx = i - 1, peakVal = close[peakIdx];
    let troughIdx = i, k = i;
    while (k < n && dd[k] < -eps) {
      if (close[k] < close[troughIdx]) troughIdx = k;
      k++;
    }
    const maxDd = dd[troughIdx];
    if (k < n) {
      events.push({
        peak_date: dates[peakIdx], peak_value: peakVal, trough_date: dates[troughIdx],
        trough_value: close[troughIdx], recovery_date: dates[k], max_drawdown: maxDd,
        down_duration: troughIdx - peakIdx, recovery_duration: k - troughIdx,
        total_duration: k - peakIdx, recovered: true
      });
    } else {
      events.push({
        peak_date: dates[peakIdx], peak_value: peakVal, trough_date: dates[troughIdx],
        trough_value: close[troughIdx], recovery_date: null, max_drawdown: maxDd,
        down_duration: troughIdx - peakIdx, recovery_duration: null, total_duration: null, recovered: false
      });
    }
    i = k;
  }
  return events;
}
function holdingReturns(close, horizon) {
  const n = close.length;
  const rets = [];
  for (let t = 0; t + horizon < n; t++) rets.push((close[t + horizon] / close[t] - 1) * 100);
  const s = sortedCopy(rets);
  const k = rets.length;
  return {
    horizon, n: k, returns_pct: rets,
    win_rate_pct: mean(rets.map(r => r > 0 ? 1 : 0)) * 100,
    loss_gt5_pct: mean(rets.map(r => r <= -5 ? 1 : 0)) * 100,
    loss_gt10_pct: mean(rets.map(r => r <= -10 ? 1 : 0)) * 100,
    loss_gt20_pct: mean(rets.map(r => r <= -20 ? 1 : 0)) * 100,
    mean_pct: mean(rets), median_pct: quantile(s, 50), min_pct: s[0], max_pct: s[k - 1],
    p5_pct: quantile(s, 5), p25_pct: quantile(s, 25), p75_pct: quantile(s, 75), p95_pct: quantile(s, 95),
  };
}
function rollingMaxDrawdown(close, window) {
  const n = close.length;
  const out = new Array(n).fill(null);
  for (let t = window - 1; t < n; t++) {
    let cm = -Infinity, minDd = 0;
    for (let j = t - window + 1; j <= t; j++) {
      cm = Math.max(cm, close[j]);
      minDd = Math.min(minDd, close[j] / cm - 1);
    }
    out[t] = minDd;
  }
  return out;
}
function rollingVol(ret, window) { // 年化波动率（%）
  const n = ret.length;
  const out = new Array(n).fill(null);
  for (let t = window - 1; t < n; t++) {
    const seg = ret.slice(t - window + 1, t + 1).map(x => x / 100);
    out[t] = sampleStd(seg) * Math.sqrt(252) * 100;
  }
  return out;
}
function yearlyGroups(returnsDates, returns) {
  const map = {};
  returns.forEach((r, i) => {
    const y = returnsDates[i].slice(0, 4);
    (map[y] = map[y] || []).push(r);
  });
  return Object.keys(map).sort().map(y => ({ year: y, values: map[y] }));
}

// ---------------- 数据加载与过滤 ----------------
async function init() {
  try {
    const resp = await fetch("data/indices.json");
    INDICES = await resp.json();
    populateIndexSelect();
    applyHash();
    await loadEvents();
    await loadStage23();
    await ensureLoaded(selectedKeys);
    currentData = dataMap[selectedKeys[0]];
    currentKey = selectedKeys[0];
    renderStatus();
    renderAll();
  } catch (e) {
    renderFatal("无法加载数据：" + e.message + "。请先运行 python update_data.py 生成数据。");
  }
}
function populateIndexSelect() {
  const box = $("#picker-panel");
  if (!box) return;
  box.innerHTML = Object.keys(INDICES).map((k) => {
    const it = INDICES[k];
    const checked = selectedKeys.includes(k);
    return `<label class="picker-item"><input type="checkbox" value="${k}" ${checked ? "checked" : ""}> ${it.name}${it.has_stats ? "" : "（无数据）"}</label>`;
  }).join("");
  $$("#picker-panel input").forEach(cb => {
    cb.onchange = async () => {
      const on = $$("#picker-panel input").filter(x => x.checked).map(x => x.value);
      if (on.length === 0) { cb.checked = true; return; }  // 至少保留一个
      selectedKeys = on;
      currentKey = selectedKeys[0];
      updatePickerLabel();
      await ensureLoaded(selectedKeys);
      currentData = dataMap[currentKey];
      renderStatus();
      renderAll();
    };
  });
  updatePickerLabel();
}
function updatePickerLabel() {
  const el = $("#picker-label");
  if (!el) return;
  if (selectedKeys.length === 1) el.textContent = INDICES[selectedKeys[0]] ? INDICES[selectedKeys[0]].name : selectedKeys[0];
  else el.textContent = `${selectedKeys.length} 个研究对象`;
}
async function ensureLoaded(keys) {
  for (const k of keys) {
    if (dataMap[k]) continue;
    try {
      const r = await fetch("data/stats/" + k + ".json");
      if (r.ok) dataMap[k] = await r.json();
    } catch (e) { /* 忽略单个失败 */ }
  }
}
async function loadData(key) {
  await ensureLoaded([key]);
  if (!dataMap[key]) { renderFatal("该指数暂无统计数据：" + key); return; }
  currentKey = key;
  currentData = dataMap[key];
  renderStatus();
  renderAll();
}
function filteredFor(d) {
  let start = null, end = null;
  if (range === "1y") start = shiftDate(d.last_date, -1);
  else if (range === "3y") start = shiftDate(d.last_date, -3);
  else if (range === "5y") start = shiftDate(d.last_date, -5);
  else if (range === "10y") start = shiftDate(d.last_date, -10);
  else if (range === "custom") { start = customStart; end = customEnd || d.last_date; }
  const returns = [], returnsDates = [];
  d.returns_pct.forEach((r, i) => {
    const dt = d.returns_dates[i];
    if (start && dt < start) return;
    if (end && dt > end) return;
    returns.push(r); returnsDates.push(dt);
  });
  const close = [], dates = [];
  d.close.forEach((c, i) => {
    const dt = d.dates[i];
    if (start && dt < start) return;
    if (end && dt > end) return;
    close.push(c); dates.push(dt);
  });
  return { returns, returnsDates, close, dates, start, end };
}
function filteredData() { return filteredFor(currentData); }
function rangeLabel() {
  const f = filteredData();
  if (f.dates.length === 0) return "无数据";
  return `${f.dates[0]} ~ ${f.dates[f.dates.length - 1]}（N=${f.returns.length}）`;
}
// 多研究对象：累计收益（起点=0% 或 净值=100）序列
function rebasedData(d) {
  const f = filteredFor(d);
  if (!f.close.length) return { x: [], y: [] };
  const base = f.close[0];
  return { x: f.dates, y: f.close.map(v => (v / base) * 100) };
}
function selectedSeries() {
  return selectedKeys.filter(k => dataMap[k]).map((k, i) => ({
    key: k, name: INDICES[k] ? INDICES[k].name : k, color: PALETTE[i % PALETTE.length],
    data: dataMap[k], filtered: filteredFor(dataMap[k])
  }));
}
// 历史事件库：为极端日匹配“可能的首要和原因”（±10 天窗口，取最近 3 条）
async function loadEvents() {
  try {
    const r = await fetch("data/events.json");
    if (r.ok) { const j = await r.json(); EVENTS = j.events || []; }
  } catch (e) { EVENTS = []; }
}
function causesFor(dateStr) {
  if (!EVENTS || !EVENTS.length) return [];
  const d0 = new Date(dateStr + "T00:00:00").getTime();
  const hits = EVENTS.map(e => {
    const dt = new Date(e.date + "T00:00:00").getTime();
    return { e, gap: Math.abs(dt - d0) / 86400000 };
  }).filter(o => o.gap <= 10).sort((a, b) => a.gap - b.gap);
  return hits.slice(0, 3).map(o => o.e);
}
async function loadStage23() {
  const files = [
    ["MARKET", "data/market_snapshot.json"],
    ["LIQUIDITY", "data/liquidity.json"],
    ["VALUATION", "data/valuation.json"],
  ];
  for (const [name, url] of files) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (name === "MARKET") MARKET = j;
      else if (name === "LIQUIDITY") LIQUIDITY = j;
      else if (name === "VALUATION") VALUATION = j;
    } catch (e) { /* 单文件失败不影响其他 */ }
  }
}
let industryLoading = false;
let industryLoadError = null;
async function ensureIndustry(moduleName) {
  if (INDUSTRY || industryLoading) return;
  industryLoading = true;
  try {
    const r = await fetch("data/industry.json");
    if (!r.ok) industryLoadError = "HTTP " + r.status;
    else { INDUSTRY = await r.json(); industryLoadError = null; }
  } catch (e) {
    industryLoadError = e.message || "网络错误";
  } finally {
    industryLoading = false;
  }
  if (activeModule === moduleName) renderAll();
}
function retryIndustry() {
  INDUSTRY = null;
  industryLoadError = null;
  ensureIndustry("p2value");
}

// ---------------- 渲染入口 ----------------
let activeModule = "overview";
function renderAll() {
  if (!currentData) return;
  try {
    if (activeModule === "overview") renderOverview();
    else if (activeModule === "p01") renderP01();
    else if (activeModule === "p02") renderP02();
    else if (activeModule === "p03") renderP03();
    else if (activeModule === "p04") renderP04();
    else if (activeModule === "p1breadth") renderP1Breadth();
    else if (activeModule === "p1liquid") renderP1Liquid();
    else if (activeModule === "p2value") renderP2Value();
  } catch (e) {
    $("#content").innerHTML = `<div class="card"><b>渲染错误</b><pre>${escapeHtml(e.stack || e.message)}</pre></div>`;
  }
}
function switchModule(m) {
  applyModule(m);
  if (location.hash !== "#" + m) { try { history.replaceState(null, "", "#" + m); } catch (e) {} }
}
function applyModule(m) {
  activeModule = m;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.module === m));
  renderAll();
  window.scrollTo(0, 0);
}
function applyHash() {
  const h = (location.hash || "").replace("#", "");
  if (["overview", "p01", "p02", "p03", "p04", "p1breadth", "p1liquid", "p2value"].includes(h)) {
    activeModule = h;
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.module === h));
  }
}

// ---------------- 概览 ----------------
function renderOverview() {
  const d = currentData, f = filteredData();
  const s = summaryStats(f.returns);
  const histPeak = Math.max(...f.close);
  const curClose = f.close[f.close.length - 1];
  const curDd = curClose / histPeak - 1;
  const p1 = s.p1;
  const c = $("#content");
  const multi = selectedKeys.length > 1;
  const scopeTxt = multi
    ? `对比研究对象：<b>${selectedSeries().map(s => s.name).join("、")}</b>（多曲线统一按“累计净值、起点=100”对比；下方 KPI 以主对象「${d.name}」为准）`
    : `研究范围：<b>${d.name}</b>（${d.market}）`;
  c.innerHTML = `
    <div class="module-intro">${scopeTxt}。本页所有数字均为<b>真实历史数据</b>的经验统计，不代表未来概率，也不构成投资建议。</div>
    <div class="kpi-row">
      ${kpi("本样本有效交易日 N", s.n, "日", `按 ${rangeLabel()} 过滤`)}
      ${kpi("最新收盘日", f.dates[f.dates.length - 1] || "—", "", `收盘 ${fmt(curClose, 2)} 点`)}
      ${kpi("历史单日下跌 P1 阈值", fmtPct(p1), p1 < 0 ? "down" : "up", "1% 最差单日收益")}
      ${kpi("当前距历史高点回撤", fmtPct(curDd * 100), curDd < 0 ? "down" : "up", `历史峰值 ${fmt(histPeak, 2)} 点`)}
    </div>
    <div class="card">
      <h3>${multi ? "多研究对象累计净值对比" : "指数收盘走势"}</h3>
      <div class="sub">${multi ? "各曲线起点统一为 100，图例可点选隐藏/显示" : `${d.first_date} ~ ${d.last_date} · 来源 ${d.source_interface} · N=${d.n}`}</div>
      <div id="ov-trend" class="chart tall"></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      ${entryCard("每日涨跌的分布", "一天跌 2% 有多常见？今天的涨跌处于历史什么百分位？", "p01")}
      ${entryCard("曾经有多惨", "极端日集中在哪些年份？左尾有多肥？", "p02")}
      ${entryCard("持有多久可能亏", "持有 5/20/250 个交易日，亏损概率如何变化？", "p04")}
      ${entryCard("牛熊、回撤与等待", "从高点到谷底跌多少？多久才能回到前高？", "p03")}
    </div>
  `;
  drawTrend("ov-trend", f, { markPeak: true });
}
function kpi(label, value, unit, note) {
  return `<div class="kpi"><div class="k-label">${label}</div>
    <div class="k-value ${unit || ""}">${value}</div><div class="k-note">${note}</div></div>`;
}
function entryCard(title, desc, module) {
  return `<div class="card" style="cursor:pointer" data-goto="${module}">
    <h3>${title}</h3><p class="sub">${desc}</p>
    <button class="btn">查看 →</button></div>`;
}

// ---------------- 通用图 ----------------
function drawTrend(id, f, opts = {}) {
  const c = getChart(id);
  const multi = selectedKeys.length > 1;
  let series, legend, yName, top;
  if (multi) {
    yName = "累计净值（起点=100）";
    top = 40;
    series = selectedSeries().map(s => {
      const rb = rebasedData(s.data);
      return { type: "line", name: s.name, data: rb.x.map((d, i) => [d, rb.y[i]]), showSymbol: false, lineStyle: { width: 1.5, color: s.color }, emphasis: { focus: "series" } };
    });
    legend = { top: 0, type: "scroll" };
  } else {
    yName = "收盘（点）";
    top = 24;
    const data = f.close.map((v, i) => [f.dates[i], v]);
    series = [{
      type: "line", name: currentData.name, data, showSymbol: false, lineStyle: { width: 1.2, color: "#2563eb" },
      areaStyle: { opacity: 0.06, color: "#2563eb" }, markLine: opts.markPeak ? peakMarkLine(f) : undefined,
      markPoint: opts.markPeak ? { data: [{ coord: [peakDate(f), peakClose(f)], value: "历史峰值" }], symbolSize: 40 } : undefined
    }];
  }
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 64, right: 24, top, bottom: 60 },
    legend,
    xAxis: { type: "time" },
    yAxis: { type: "value", scale: true, name: yName },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    series
  }, true);
}
function peakClose(f) { return Math.max(...f.close); }
function peakDate(f) { const i = f.close.indexOf(peakClose(f)); return f.dates[i]; }
function peakMarkLine(f) {
  return { symbol: "none", lineStyle: { type: "dashed", color: "#94a3b8" }, label: { formatter: "历史峰值 " + fmt(peakClose(f), 2), position: "insideEndTop" }, data: [{ yAxis: peakClose(f) }] };
}
function getChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id]) { charts[id].dispose(); }
  const c = echarts.init(el);
  charts[id] = c;
  return c;
}
// 数据未就绪时，在图表区域显式写明原因，避免出现“白板空图”
function chartNotice(id, text) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id]) { charts[id].dispose(); delete charts[id]; }
  const c = echarts.init(el);
  charts[id] = c;
  c.setOption({
    title: {
      text, left: "center", top: "middle",
      textStyle: { fontSize: 13, color: "#94a3b8", fontWeight: "normal" }
    },
    xAxis: { show: false }, yAxis: { show: false }, series: []
  }, true);
  return null;
}
function baseGrid() { return { left: 56, right: 24, top: 26, bottom: 48 }; }
function baseTooltip() {
  return {
    trigger: "axis",
    axisPointer: { type: "cross" },
    backgroundColor: "#fff", borderColor: "#e4e7ec", textStyle: { color: "#1f2937" }
  };
}

// ---------------- P0-1 每日涨跌分布 ----------------
function renderP01() {
  const d = currentData, f = filteredData();
  const s = summaryStats(f.returns);
  const c = $("#content");
  c.innerHTML = `
    <div class="section-title">P0-1 每日涨跌幅的概率分布</div>
    <div class="module-intro"><b>研究问题</b>：上证指数一天跌 2%、3%、5% 分别有多常见？今天的涨跌放到过去历史，属于什么百分位？</div>
    <div class="kpi-row">
      ${kpi("样本量 N", s.n, "日", rangeLabel())}
      ${kpi("日均收益", fmtPct(s.mean_pct), s.mean_pct >= 0 ? "up" : "down", "算术平均")}
      ${kpi("年化波动率", fmtPct(s.annualized_vol_pct), "", "std×√252")}
      ${kpi("正收益日占比", fmtPct(s.positive_days_pct), "up", "负收益 " + fmtPct(s.negative_days_pct))}
    </div>

    <div class="card">
      <h3>图 A：日收益率分布（直方图 + 核密度 + 正态参考）</h3>
      <div class="sub">概率密度口径，柱面积之和=1；正态曲线按相同均值/标准差拟合</div>
      <div class="ctrl-row">
        <label>bin 宽度
          <span class="seg" id="bin-seg">
            ${[0.1, 0.25, 0.5, 1.0].map(b => `<button data-bin="${b}" class="${b === binWidth ? "active" : ""}">${b}</button>`).join("")}
          </span>
        </label>
        <label><input type="checkbox" id="kde-toggle" ${showKde ? "checked" : ""}> 核密度估计</label>
        <label><input type="checkbox" id="normal-toggle" ${showNormal ? "checked" : ""}> 正态参考</label>
        <button class="btn" id="dl-p01">下载 PNG</button>
      </div>
      <div id="p01-hist" class="chart tall"></div>
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>图 B：经验累积分布 ECDF 与左尾</h3>
        <div class="sub">F(x) = #{R ≤ x}/N（含相等值）</div>
        <div class="threshold-box">
          <label>输入涨跌幅 x%</label>
          <input type="number" id="thr-input" value="-2" step="0.1">
          <button class="btn" id="thr-apply">计算</button>
          <span class="small-note">P(R≤x) / P(R≤-|x|) / P(|R|≥|x|)</span>
        </div>
        <div id="thr-results"></div>
        <div id="p01-ecdf" class="chart tall"></div>
      </div>
      <div class="card">
        <h3>按交易日查询百分位</h3>
        <div class="sub">选择一个真实交易日，看其收益处于历史什么位置（含只比较下跌日 / 只比较上涨日）</div>
        <div class="threshold-box">
          <input type="date" id="date-query" value="${f.dates[f.dates.length - 1] || ""}" min="${f.dates[0] || ""}" max="${f.dates[f.dates.length - 1] || ""}">
          <button class="btn" id="date-apply">查询</button>
        </div>
        <div id="date-result"></div>
        <div id="date-mini" class="chart short"></div>
        <div class="note find"><b>这张图告诉我们什么：</b>极端下跌比直觉中更常见；负向极端比正向极端更极端。</div>
        <div class="note misread"><b>容易误读：</b>历史频率不是未来概率；样本越小估计越不稳定。</div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>图 C：逐年日收益率分布（箱线）</h3>
        <div class="sub">最近 15 年，每年日收益的箱线（中位数、四分位、须、离群点）</div>
        <div id="p01-yearly" class="chart"></div>
      </div>
      <div class="card">
        <h3>图 D：单日极端涨跌 TOP20（含主要原因）</h3>
        <div class="sub">点击任一行可在走势图上定位该日；“主要原因”来自人工整理的历史事件库（±10 天匹配），未收录则如实标注</div>
        <div style="font-weight:600;color:var(--up);margin:4px 0 6px">最大单日上涨</div>
        ${extremeTable(f, "up", "最大单日上涨")}
        <div style="height:16px"></div>
        <div style="font-weight:600;color:var(--down);margin:4px 0 6px">最大单日下跌</div>
        ${extremeTable(f, "down", "最大单日下跌")}
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>对称尾部事件实际频率</h3>
      <div class="sub">P(R ≤ -a)、P(R ≥ +a)、P(|R| ≥ a)（当前筛选区间内）</div>
      ${tailTable(f)}
    </div>

    <div class="card" style="margin-top:14px">
      <h3>完整描述统计</h3>
      <div class="sub">标准差为样本标准差 ddof=1；偏度/超额峰度受早期（1990年代）极端行情影响较大</div>
      ${summaryTable(s)}
    </div>
  `;

  drawHistogram(f, s);
  drawEcdf(f, s);
  drawYearly(f);
  bindP01(f, s);
  renderThr(f, -2);
}

function drawHistogram(f, s) {
  const c = getChart("p01-hist");
  const h = histogram(f.returns, binWidth);
  const series = [{ type: "bar", name: "日收益频率", data: h.centers.map((x, i) => [x, h.density[i]]), barWidth: "92%", itemStyle: { color: "#c7d2fe" } }];
  if (showKde) {
    const k = gaussianKde(f.returns);
    series.push({ type: "line", name: "核密度", data: k.x.map((x, i) => [x, k.y[i]]), showSymbol: false, lineStyle: { width: 2, color: UP }, smooth: true });
  }
  if (showNormal) {
    const xr = h.centers;
    const nd = normalPdf(xr, s.mean_pct, s.std_pct);
    series.push({ type: "line", name: "正态参考", data: xr.map((x, i) => [x, nd[i]]), showSymbol: false, lineStyle: { width: 1.5, color: "#94a3b8", type: "dashed" } });
  }
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => `${fmt(p[0].value[0], 2)}%<br/>密度 ${fmt(p[0].value[1], 4)}` },
    grid: baseGrid(), legend: { top: 0 },
    xAxis: { type: "value", name: "日收益率 (%)", scale: true },
    yAxis: { type: "value", name: "概率密度" },
    series
  }, true);
}
function drawEcdf(f, s) {
  const c = getChart("p01-ecdf");
  const list = selectedSeries();
  const multi = list.length > 1;
  const series = list.map(ss => {
    const e = ecdf(ss.filtered.returns);
    const item = { type: "line", name: ss.name, data: e.x.map((x, i) => [x, e.y[i]]), step: "end", showSymbol: false, lineStyle: { width: multi ? 1.6 : 2, color: multi ? ss.color : "#2563eb" } };
    if (!multi) {
      const srt = sortedCopy(ss.filtered.returns);
      item.markLine = { symbol: "none", data: [1, 5].map(p => ({ xAxis: quantile(srt, p), label: { formatter: "P" + p, position: "start" }, lineStyle: { type: "dashed", color: "#94a3b8" } })) };
    }
    return item;
  });
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(), legend: { top: 0, type: "scroll" },
    xAxis: { type: "value", name: "日收益率 (%)", scale: true },
    yAxis: { type: "value", name: "F(x) (%)", min: 0, max: 100 },
    series
  }, true);
}
function drawYearly(f) {
  const c = getChart("p01-yearly");
  const groups = yearlyGroups(f.returnsDates, f.returns).slice(-15);
  const data = groups.map(g => {
    const s = sortedCopy(g.values);
    const q1 = quantile(s, 25), med = quantile(s, 50), q3 = quantile(s, 75);
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
    const outliers = g.values.filter(v => v < lower || v > upper).map(v => [g.year, v]);
    return { year: g.year, low: lower, q1, med, q3, upper, outliers };
  });
  c.setOption({
    tooltip: { trigger: "item", formatter: (p) => { const d = p.data; return `${d.year}<br/>上须 ${fmt(d.upper)}<br/>Q3 ${fmt(d.q3)}<br/>中位 ${fmt(d.med)}<br/>Q1 ${fmt(d.q1)}<br/>下须 ${fmt(d.low)}`; } },
    grid: baseGrid(),
    xAxis: { type: "category", data: data.map(d => d.year), axisLabel: { rotate: 45, fontSize: 10 } },
    yAxis: { type: "value", name: "日收益率 (%)" },
    series: [{
      type: "boxplot", data: data.map(d => [d.low, d.q1, d.med, d.q3, d.upper]),
      itemStyle: { color: "#e0e7ff", borderColor: "#6366f1" }
    }, {
      type: "scatter", data: data.flatMap(d => d.outliers), itemStyle: { color: "#94a3b8" }, symbolSize: 3
    }]
  }, true);
}
function extremeTable(f, kind, title) {
  const d = currentData;
  const all = kind === "up" ? d.extreme_events.up : d.extreme_events.down;
  let list = all.filter(ev => (!f.start || ev.date >= f.start) && (!f.end || ev.date <= f.end));
  let fallback = false;
  if (list.length < 10) { list = all; fallback = true; }
  const rows = list.map(ev => {
    const cs = causesFor(ev.date);
    const causeTxt = cs.length
      ? cs.map(c => `<div class="cause"><b>${c.date === ev.date ? "" : c.date + " "}</b>${c.title}：${c.cause}</div>`).join("")
      : `<div class="cause muted">未收录明确事件（可能为情绪/流动性冲击）</div>`;
    return `<tr class="clickable" data-date="${ev.date}"><td style="white-space:nowrap">${ev.date}</td><td class="${kind === "up" ? "up" : "down"}" style="white-space:nowrap">${ev.ret_pct >= 0 ? "+" : ""}${fmt(ev.ret_pct, 2)}%</td><td class="cause-cell">${causeTxt}</td></tr>`;
  }).join("");
  return `${fallback ? `<div class="small-note" style="margin-bottom:6px">当前筛选区间极端事件不足 10 个，已退回显示<b>全历史 TOP20</b>。</div>` : ""}
  <table><thead><tr><th>日期</th><th>涨跌幅</th><th style="text-align:left">可能的主要原因（最多 3 条）</th></tr></thead><tbody>${rows || "<tr><td colspan=3>无</td></tr>"}</tbody></table>`;
}
function tailTable(f) {
  const rows = [1, 2, 3, 5].map(a => {
    const t = tailFreq(f.returns, a);
    return `<tr><td>${a}%</td><td class="down">${fmt(t.p_le_neg_pct)}% (${t.count_le_neg}日)</td><td class="up">${fmt(t.p_ge_pos_pct)}% (${t.count_ge_pos}日)</td><td>${fmt(t.p_abs_ge_pct)}% (${t.count_abs_ge}日)</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>阈值 a</th><th>P(R≤-a)</th><th>P(R≥+a)</th><th>P(|R|≥a)</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function summaryTable(s) {
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  return `<table><thead><tr><th>指标</th><th>数值</th></tr></thead><tbody>
    ${row("均值 (%)", fmt(s.mean_pct, 4))}${row("中位数 (%)", fmt(s.median_pct, 4))}
    ${row("样本标准差 (%)", fmt(s.std_pct, 4))}${row("年化波动率 (%)", fmt(s.annualized_vol_pct, 2))}
    ${row("P1 / P5 / P25 / P50 (%)", `${fmt(s.p1, 3)} / ${fmt(s.p5, 3)} / ${fmt(s.p25, 3)} / ${fmt(s.p50, 3)}`)}
    ${row("P75 / P95 / P99 (%)", `${fmt(s.p75, 3)} / ${fmt(s.p95, 3)} / ${fmt(s.p99, 3)}`)}
    ${row("最小值 / 最大值 (%)", `${fmt(s.min_pct, 3)} / ${fmt(s.max_pct, 3)}`)}
    ${row("偏度 / 超额峰度", `${fmt(s.skewness, 3)} / ${fmt(s.excess_kurtosis, 2)}`)}
    ${row("正/负/零收益日占比 (%)", `${fmt(s.positive_days_pct, 2)} / ${fmt(s.negative_days_pct, 2)} / ${fmt(s.zero_days_pct, 2)}`)}
  </tbody></table>`;
}
function renderThr(f, x) {
  const box = $("#thr-results");
  if (!box) return;
  const n = f.returns.length;
  const a = Math.abs(x);
  const neg = f.returns.filter(r => r < 0);
  const pos = f.returns.filter(r => r > 0);
  const fneg = mean(f.returns.map(r => r <= x ? 1 : 0)) * 100;
  const fle = mean(f.returns.map(r => r <= -a ? 1 : 0)) * 100;
  const fabs = mean(f.returns.map(r => Math.abs(r) >= a ? 1 : 0)) * 100;
  const cNeg = f.returns.filter(r => r <= -a).length;
  const cAbs = f.returns.filter(r => Math.abs(r) >= a).length;
  // 下跌日序列内：跌幅 >= a 的下跌日占比；下跌日序列内百分位（越大越深）
  const downGe = neg.length ? neg.filter(r => r <= -a).length : 0;
  const downPct = neg.length ? downGe / neg.length * 100 : NaN;
  // 上涨日序列内：涨幅 <= a 的上涨日占比；即 a 在上涨序列的百分位
  const upLe = pos.length ? pos.filter(r => r <= a).length : 0;
  const upPct = pos.length ? upLe / pos.length * 100 : NaN;
  box.innerHTML = `
    <div class="result-line">P(R ≤ ${fmt(x)}) = <b>${fmt(fneg)}%</b>（全部 ${n} 天中的左侧累计概率）</div>
    <div class="result-line">P(R ≤ -${fmt(a)}) = <b>${fmt(fle)}%</b>（至少这么大负向跌幅，${cNeg} 次 / ${n} 天）</div>
    <div class="result-line">P(|R| ≥ ${fmt(a)}) = <b>${fmt(fabs)}%</b>（不低于该幅度的绝对波动，${cAbs} 次；平均每 ${cAbs ? fmt(n / cAbs, 1) : "∞"} 交易日一次）</div>
    <div class="result-line" style="border-top:1px solid #f1f5f9;margin-top:6px;padding-top:8px">
      <b>只看下跌日（${neg.length} 天）</b>：跌幅 ≥ ${fmt(a)}% 的下跌日占 <b>${isNaN(downPct) ? "—" : fmt(downPct)}%</b>
      <span class="small-note">（-${fmt(a)}% 处在下跌序列的"较深一侧"，占比越小说明它越接近轻度下跌）</span>
    </div>
    <div class="result-line">
      <b>只看上涨日（${pos.length} 天）</b>：涨幅 ≤ ${fmt(a)}% 的上涨日占 <b>${isNaN(upPct) ? "—" : fmt(upPct)}%</b>
      <span class="small-note">（即 +${fmt(a)}% 超过 ${isNaN(upPct) ? "—" : fmt(upPct)}% 的上涨日）</span>
    </div>`;
  // 同步在 ECDF 上画阈值线
  drawEcdfThreshold(f, x);
}
function drawEcdfThreshold(f, x) {
  const c = charts["p01-ecdf"];
  if (!c) return;
  if (selectedSeries().length > 1) return;  // 多曲线时不做单阈值标记，避免误导
  const s = sortedCopy(f.returns);
  const marks = [1, 5].map(p => ({ xAxis: quantile(s, p), label: { formatter: "P" + p, position: "start" }, lineStyle: { type: "dashed", color: "#94a3b8" } }));
  marks.push({ xAxis: x, label: { formatter: "x=" + fmt(x), position: "start" }, lineStyle: { color: UP } });
  c.setOption({ series: [{ markLine: { symbol: "none", data: marks } }] });
}
function bindP01(f, s) {
  $$("#bin-seg button").forEach(b => b.onclick = () => { binWidth = parseFloat(b.dataset.bin); $$("#bin-seg button").forEach(x => x.classList.toggle("active", x === b)); drawHistogram(f, s); });
  $("#kde-toggle").onchange = (e) => { showKde = e.target.checked; drawHistogram(f, s); };
  $("#normal-toggle").onchange = (e) => { showNormal = e.target.checked; drawHistogram(f, s); };
  $("#thr-apply").onclick = () => renderThr(f, parseFloat($("#thr-input").value) || 0);
  $("#thr-input").onkeydown = (e) => { if (e.key === "Enter") renderThr(f, parseFloat(e.target.value) || 0); };
  $("#date-apply").onclick = () => queryDate(f);
  $("#dl-p01").onclick = () => downloadPng("p01-hist", "P01_日收益分布_" + currentKey);
  $$("#content tr.clickable").forEach(tr => tr.onclick = () => {
    selectedDate = tr.dataset.date;
    switchModule("p03");
  });
}
function queryDate(f) {
  const dt = $("#date-query").value;
  const box = $("#date-result");
  if (!dt || !box) return;
  const i = f.returnsDates.indexOf(dt);
  if (i < 0) { box.innerHTML = `<div class="small-note">该日期在当前区间内无收益记录（可能非交易日或不在筛选区间）。</div>`; return; }
  const r = f.returns[i];
  const n = f.returns.length;
  const pct = mean(f.returns.map(x => x <= r ? 1 : 0)) * 100;
  const cnt = f.returns.filter(x => x <= r).length;
  const cntAbs = f.returns.filter(x => Math.abs(x) >= Math.abs(r)).length;
  const neg = f.returns.filter(x => x < 0);
  const pos = f.returns.filter(x => x > 0);
  let within = "";
  if (r < 0 && neg.length) {
    const c = neg.filter(x => x <= r).length;
    const p = c / neg.length * 100;
    within = `只看下跌日（${neg.length} 天）：跌得比它更狠或一样的有 <b>${fmt(p)}%</b>（它比 ${fmt(100 - p)}% 的下跌日更温和）`;
  } else if (r > 0 && pos.length) {
    const c = pos.filter(x => x <= r).length;
    const p = c / pos.length * 100;
    within = `只看上涨日（${pos.length} 天）：涨幅不超过它的有 <b>${fmt(p)}%</b>（它超过 ${fmt(p)}% 的上涨日）`;
  }
  box.innerHTML = `
    <div class="result-line">${dt} 当日收益 = <b class="${r >= 0 ? "up" : "down"}">${r >= 0 ? "+" : ""}${fmt(r, 2)}%</b></div>
    <div class="result-line">全部交易日中位于下侧第 <b>${fmt(pct)}</b> 百分位（F(x)=#{R≤x}/N）</div>
    <div class="result-line" style="color:#1d4ed8">${within}</div>
    <div class="result-line">同等或更大跌幅出现 <b>${cnt}</b> 次 / ${n} 天；平均每 <b>${cnt ? fmt(n / cnt, 1) : "∞"}</b> 个交易日一次</div>
    <div class="result-line">绝对值 ≥ |${fmt(Math.abs(r), 2)}%| 的波动出现 <b>${cntAbs}</b> 次</div>`;
  drawDateMini(f, r, dt);
}
function drawDateMini(f, r, dt) {
  const c = getChart("date-mini");
  const e = ecdf(f.returns);
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => `${fmt(p[0].value[0], 2)}%<br/>F=${fmt(p[0].value[1], 2)}%` },
    grid: { left: 52, right: 24, top: 26, bottom: 34 },
    xAxis: { type: "value", name: "日收益 (%)", scale: true },
    yAxis: { type: "value", name: "F(x) (%)", min: 0, max: 100 },
    series: [{
      type: "line", name: "ECDF", data: e.x.map((x, i) => [x, e.y[i]]), step: "end", showSymbol: false,
      lineStyle: { width: 1.6, color: "#2563eb" },
      markLine: { symbol: "none", data: [{ xAxis: r, label: { formatter: `${dt.slice(5)} ${fmt(r, 2)}%`, color: UP, position: "insideEndTop" }, lineStyle: { color: UP } }] }
    }]
  }, true);
}

// ---------------- P0-2 极端事件与尾部 ----------------
function renderP02() {
  const d = currentData, f = filteredData();
  const s = summaryStats(f.returns);
  const volWin = Math.min(250, Math.max(20, Math.floor(f.returns.length * 0.8)));
  const c = $("#content");
  c.innerHTML = `
    <div class="section-title">P0-2 极端市场风险、尾部分布与历史异常波动</div>
    <div class="module-intro"><b>研究问题</b>：为什么平均每天只波动一点点，不意味着不会突然巨亏？极端日集中在哪些年份或行情阶段？</div>
    <div class="card">
      <h3>图 1：日收益时序散点（标注最极端 20 次涨跌）</h3>
      <div class="sub">红=上涨、绿=下跌；点越大波动越大</div>
      <div id="p02-scatter" class="chart tall"></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>图 2：绝对日收益率按年份分布（热力柱）</h3>
        <div class="sub">每根柱为一次 |日收益| ≥ 2% 的事件，高度为幅度</div>
        <div id="p02-year" class="chart tall"></div>
      </div>
      <div class="card">
        <h3>图 3：滚动 ${volWin} 日年化波动率</h3>
        <div class="sub">波动聚集现象：高波动期成簇出现（窗口按样本长度自适应，最长 250 日）</div>
        <div id="p02-vol" class="chart tall"></div>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>图 4：左尾频率——历史经验 vs 正态预测</h3>
        <div class="sub">同一均值/标准差下的正态分布，会低估“大跌”出现的频率；橙线=经验是正态的几倍</div>
        <div id="p02-lefttail" class="chart tall"></div>
      </div>
      <div class="card">
        <h3>历史 VaR / CVaR（Expected Shortfall）</h3>
        <div class="sub">历史分位法；CVaR 为条件尾部均值；样本不足时不展示</div>
        ${varCvarTable(f)}
        <div class="note misread"><b>容易误读：</b>峰度高不证明未来某日必然暴跌；VaR/CVaR 只是历史样本的经验分位，不是预测。</div>
      </div>
    </div>
  `;
  drawP02Scatter(f);
  drawP02Year(f);
  drawP02Vol(f, volWin);
  drawP02LeftTail(f, s);
}
function drawP02Scatter(f) {
  const c = getChart("p02-scatter");
  const upData = [], downData = [];
  f.returns.forEach((r, i) => {
    (r >= 0 ? upData : downData).push([f.returnsDates[i], r]);
  });
  const up = [...f.returns].sort((a, b) => b - a).slice(0, 20);
  const down = [...f.returns].sort((a, b) => a - b).slice(0, 20);
  const markPts = [];
  f.returns.forEach((r, i) => {
    if (up.includes(r) || down.includes(r)) markPts.push({ coord: [f.returnsDates[i], r], symbolSize: 6, itemStyle: { borderColor: "#0f172a", borderWidth: 1 } });
  });
  c.setOption({
    tooltip: { ...baseTooltip(), formatter: (p) => `${p.value[0]}<br/>收益 <b style="color:${p.value[1] >= 0 ? UP : DOWN}">${p.value[1] >= 0 ? "+" : ""}${fmt(p.value[1], 2)}%</b>` },
    grid: { left: 64, right: 24, top: 34, bottom: 64 },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "日收益 (%)", scale: true },
    dataZoom: [
      { type: "inside", xAxisIndex: 0 },
      { type: "inside", yAxisIndex: 0 },
      { type: "slider", xAxisIndex: 0, height: 14, bottom: 6 }
    ],
    series: [
      { type: "scatter", name: "上涨日", data: upData, large: true, symbolSize: 4, itemStyle: { color: UP, opacity: 0.45 }, markPoint: { data: markPts, label: { show: false } } },
      { type: "scatter", name: "下跌日", data: downData, large: true, symbolSize: 4, itemStyle: { color: DOWN, opacity: 0.45 } }
    ]
  }, true);
}
function drawP02Year(f) {
  const c = getChart("p02-year");
  const years = yearlyGroups(f.returnsDates, f.returns);
  const buckets = ["2%~3%", "3%~4%", "4%~5%", ">5%"];
  const counts = {};
  let maxC = 0;
  years.forEach((g, yi) => {
    g.values.forEach(v => {
      const a = Math.abs(v);
      if (a < 2) return;
      let bi = 0;
      if (a >= 5) bi = 3; else if (a >= 4) bi = 2; else if (a >= 3) bi = 1;
      const k = yi + "-" + bi;
      counts[k] = (counts[k] || 0) + 1;
      maxC = Math.max(maxC, counts[k]);
    });
  });
  const data = [];
  years.forEach((g, yi) => buckets.forEach((b, bi) => {
    const v = counts[yi + "-" + bi] || 0;
    if (v > 0) data.push({ value: [yi, bi, v], year: g.year, bucket: b });
  }));
  c.setOption({
    tooltip: { formatter: (p) => `${p.data.year}<br/>|日收益| ${p.data.bucket}<br/>发生 <b>${p.value[2]}</b> 次` },
    grid: { left: 72, right: 24, top: 16, bottom: 58 },
    xAxis: { type: "category", data: years.map(g => g.year), axisLabel: { rotate: 45, fontSize: 10 } },
    yAxis: { type: "category", data: buckets },
    visualMap: { min: 0, max: Math.max(1, maxC), calculable: true, orient: "vertical", right: 2, top: 20, itemHeight: 90, inRange: { color: ["#eef2ff", "#818cf8", "#312e81"] }, textStyle: { fontSize: 10 } },
    series: [{ type: "heatmap", data, label: { show: true, fontSize: 10, color: "#1f2937" }, emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,.3)" } } }]
  }, true);
}
function drawP02Vol(f, win) {
  const c = getChart("p02-vol");
  const n = f.returns.length;
  if (n < 40) {
    c.setOption({ title: { text: "样本不足（需 ≥40 个交易日）", left: "center", top: "middle", textStyle: { fontSize: 14, color: "#94a3b8", fontWeight: "normal" } } }, true);
    return;
  }
  const vol = rollingVol(f.returns, win);
  const data = f.returnsDates.map((dt, i) => [dt, vol[i]]).filter(p => p[1] !== null);
  c.setOption({
    tooltip: { ...baseTooltip(), formatter: (p) => `${p.value[0]}<br/>年化波动率 ${fmt(p.value[1])}%` },
    grid: baseGrid(),
    xAxis: { type: "time" }, yAxis: { type: "value", name: "年化波动率 (%)" },
    dataZoom: [{ type: "inside" }],
    series: [{ type: "line", data, showSymbol: false, lineStyle: { width: 1.4, color: "#7c3aed" }, areaStyle: { opacity: 0.06 } }]
  }, true);
}
function drawP02LeftTail(f, s) {
  const c = getChart("p02-lefttail");
  const ths = [1, 2, 3, 5];
  const emp = ths.map(a => mean(f.returns.map(r => r <= -a ? 1 : 0)) * 100);
  const nrm = ths.map(a => {
    const z = (-a - s.mean_pct) / s.std_pct;
    return 0.5 * (1 + erf(z / Math.SQRT2)) * 100;
  });
  const ratio = emp.map((e, i) => nrm[i] > 0 ? e / nrm[i] : NaN);
  c.setOption({
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (p) => {
        const i = p[0].dataIndex;
        return `跌幅 ≥ ${ths[i]}%<br/>历史经验概率 <b>${fmt(emp[i], 2)}%</b><br/>正态预测概率 ${fmt(nrm[i], 3)}%<br/>经验 / 正态 = <b>${fmt(ratio[i], 1)} 倍</b>`;
      }
    },
    grid: { left: 56, right: 64, top: 40, bottom: 40 }, legend: { top: 0 },
    xAxis: { type: "category", data: ths.map(a => "≥ " + a + "%") },
    yAxis: [
      { type: "value", name: "左尾概率 (%)" },
      { type: "value", name: "倍数", position: "right", splitLine: { show: false } }
    ],
    series: [
      { type: "bar", name: "历史经验概率", data: emp, itemStyle: { color: DOWN }, barGap: "10%" },
      { type: "bar", name: "正态预测", data: nrm, itemStyle: { color: "#94a3b8" } },
      { type: "line", name: "经验/正态倍数", yAxisIndex: 1, data: ratio, symbolSize: 7, lineStyle: { color: "#b45309", width: 2 }, itemStyle: { color: "#b45309" } }
    ]
  }, true);
}
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function varCvarTable(f) {
  const s = sortedCopy(f.returns);
  const n = f.returns.length;
  const rows = [95, 99].map(p => {
    const tailProb = 1 - p / 100;                 // 95% -> 最差 5%
    const idx = Math.max(0, Math.ceil(tailProb * n) - 1);
    const varPct = s[idx];                         // 下尾分位（负收益边界）
    const tail = s.slice(0, idx + 1);
    const cvar = mean(tail);
    const ok = tail.length >= 30;
    return `<tr><td>${p}%</td><td class="down">${fmt(varPct, 3)}%</td><td class="down">${ok ? fmt(cvar, 3) + "%" : "样本不足"}</td><td>${tail.length} 天（约每 ${tailProb ? fmt(1 / tailProb, 0) : "—"} 天一次）</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>置信水平</th><th>VaR（最差尾部边界）</th><th>CVaR（尾部平均）</th><th>尾部样本</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="small-note" style="margin-top:6px;line-height:1.7">
    <b>怎么读：</b>VaR95 = 本样本中最差 5% 的单日收益的<b>分界值</b>（约在 ${fmt(s[Math.max(0,Math.ceil(0.05*n)-1)],2)}%）；CVaR95 = 这最差 5% 的交易日的<b>平均</b>收益。<br/>
    它回答的是：<b>“极端差的那几天，平均有多差”</b>。数值为负表示亏损方向；它只来自历史样本，不是未来预测。
  </div>`;
}

// ---------------- P0-3 牛熊、回撤 ----------------
function renderP03() {
  const d = currentData, f = filteredData();
  const events = drawdownEvents(f.close, f.dates);
  const deep = events.filter(e => e.max_drawdown <= -0.05);
  const histPeak = Math.max(...f.close);
  const curClose = f.close[f.close.length - 1];
  const curDd = curClose / histPeak - 1;
  const mdd = deep.length ? deep.reduce((a, b) => a.max_drawdown <= b.max_drawdown ? a : b) : null;
  // 水下比例（O(N) 运行累计峰值）
  let runMax = -Infinity;
  const ddArr = f.close.map(c => { runMax = Math.max(runMax, c); return c / runMax - 1; });
  const under = (t) => mean(ddArr.map(x => x <= -t / 100 ? 1 : 0)) * 100;
  const c = $("#content");
  c.innerHTML = `
    <div class="section-title">P0-3 牛熊周期、最大回撤、回撤持续时间与恢复周期</div>
    <div class="module-intro"><b>研究问题</b>：市场从历史高点下跌多少？价格低于前高的时间占多大比例？重大回撤要多久恢复？</div>
    <div class="kpi-row">
      ${kpi("区间最大回撤", mdd ? fmtPct(mdd.max_drawdown * 100) : "—", "down", mdd ? `${mdd.peak_date} → ${mdd.trough_date}` : "")}
      ${kpi("当前距区间高点回撤", fmtPct(curDd * 100), curDd < 0 ? "down" : "up", "区间峰值 " + fmt(histPeak, 2))}
      ${kpi("回撤 ≤ -5% 交易日占比", fmtPct(under(5)), "", "≤ -10%: " + fmtPct(under(10)) + "；≤ -20%: " + fmtPct(under(20)))}
      ${kpi("重大回撤事件(≤-5%)", deep.length, "次", "共 " + events.length + " 个水下区间")}
    </div>
    <div class="card">
      <h3>图 A：指数价格与历史峰值</h3>
      <div class="ctrl-row"><label><input type="checkbox" id="log-toggle" ${logScale ? "checked" : ""}> 对数纵轴</label></div>
      <div id="p03-price" class="chart tall"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>图 B：回撤水下图（DD = 收盘 / 历史累计峰值 - 1）</h3>
      <div class="sub">阴影越深，回撤越深</div>
      <div id="p03-uw" class="chart tall"></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>图 C：回撤事件深度 - 持续时长散点</h3>
        <div class="sub">右删失（未恢复）事件以空心标注</div>
        <div id="p03-scatter" class="chart tall"></div>
      </div>
      <div class="card">
        <h3>重大回撤事件（深度 ≤ -5%）</h3>
        <div class="sub">点击可查看详情</div>
        <div id="p03-table">${drawdownTable(deep)}</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>图 E：滚动最大回撤（1 年 / 3 年窗口）</h3>
      <div class="sub">250 / 756 个交易日内出现的最大回撤</div>
      <div id="p03-roll" class="chart tall"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>回撤状态统计</h3>
      ${underwaterInfo(d, f)}
    </div>
  `;
  drawPrice(f);
  drawUnderwater(f);
  drawDrawdownScatter(events);
  drawRollingMdd(f);
  bindP03(f);
}
function drawPrice(f) {
  const c = getChart("p03-price");
  const multi = selectedKeys.length > 1;
  let series, legend, yName, top;
  if (multi) {
    yName = "累计净值（起点=100）"; top = 40;
    series = selectedSeries().map(ss => {
      const rb = rebasedData(ss.data);
      return { type: "line", name: ss.name, data: rb.x.map((d, i) => [d, rb.y[i]]), showSymbol: false, lineStyle: { width: 1.5, color: ss.color }, emphasis: { focus: "series" } };
    });
    legend = { top: 0, type: "scroll" };
  } else {
    yName = "收盘（点）"; top = 24;
    const data = f.close.map((v, i) => [f.dates[i], v]);
    const peak = peakClose(f);
    const markData = [{ yAxis: peak, label: { formatter: "峰值 " + fmt(peak, 2), position: "insideEndTop" } }];
    if (selectedDate && f.dates.includes(selectedDate)) {
      markData.push({ xAxis: selectedDate, label: { formatter: "定位 " + selectedDate, position: "start", color: UP }, lineStyle: { color: UP } });
    }
    series = [{ type: "line", name: currentData.name, data, showSymbol: false, lineStyle: { width: 1.3, color: "#2563eb" }, markLine: { symbol: "none", data: markData, lineStyle: { type: "dashed", color: "#94a3b8" } } }];
  }
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 64, right: 24, top, bottom: 60 },
    legend,
    xAxis: { type: "time" },
    yAxis: !multi && logScale ? { type: "log", scale: true, name: yName } : { type: "value", scale: true, name: yName },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6 }],
    series
  }, true);
}
function drawUnderwater(f) {
  const c = getChart("p03-uw");
  const multi = selectedKeys.length > 1;
  const list = multi ? selectedSeries() : [{ name: currentData.name, color: DOWN, filtered: f }];
  const series = list.map(ss => {
    let m = -Infinity;
    const data = ss.filtered.close.map((v, i) => { m = Math.max(m, v); return [ss.filtered.dates[i], (v / m - 1) * 100]; });
    return { type: "line", name: ss.name, data, showSymbol: false, lineStyle: { color: multi ? ss.color : DOWN, width: multi ? 1.2 : 1 }, areaStyle: multi ? undefined : { color: DOWN, opacity: 0.5 } };
  });
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(), legend: multi ? { top: 0, type: "scroll" } : undefined,
    xAxis: { type: "time" }, yAxis: { type: "value", name: "回撤 (%)", max: 0 },
    dataZoom: [{ type: "inside" }],
    series
  }, true);
}
function drawDrawdownScatter(events) {
  const c = getChart("p03-scatter");
  const data = events.map(e => ({
    value: [e.max_drawdown * 100, e.down_duration],
    name: `${e.peak_date}→${e.trough_date}`, recovered: e.recovered,
    itemStyle: e.recovered ? { color: DOWN, opacity: 0.7 } : { color: UP, opacity: 0.6, borderColor: UP, borderWidth: 1 }
  }));
  c.setOption({
    tooltip: { ...baseTooltip(), formatter: (p) => `${p.data.name}<br/>深度 ${fmt(p.value[0], 1)}%<br/>下跌持续 ${p.value[1]} 交易日<br/>${p.data.recovered ? "已恢复" : "未恢复（右删失）"}` },
    grid: baseGrid(),
    xAxis: { type: "value", name: "最大回撤深度 (%)", scale: true },
    yAxis: { type: "value", name: "下跌持续（交易日）" },
    series: [{ type: "scatter", data, symbolSize: 9 }]
  }, true);
}
function drawdownTable(events) {
  const sorted = events.slice().sort((a, b) => a.max_drawdown - b.max_drawdown);
  const rows = sorted.map(e => `<tr><td>${e.peak_date}</td><td>${e.trough_date}</td><td class="down">${fmt(e.max_drawdown * 100, 1)}%</td><td>${e.down_duration}</td><td>${e.recovered ? (e.recovery_date || "") : "未恢复"}</td></tr>`).join("");
  return `<table><thead><tr><th>峰值日</th><th>谷底日</th><th>深度</th><th>下跌(日)</th><th>恢复日</th></tr></thead><tbody>${rows || "<tr><td colspan=5>无</td></tr>"}</tbody></table>`;
}
function drawRollingMdd(f) {
  const c = getChart("p03-roll");
  const m1 = rollingMaxDrawdown(f.close, 252), m3 = rollingMaxDrawdown(f.close, 756);
  const s1 = f.dates.map((dt, i) => [dt, m1[i] === null ? null : m1[i] * 100]).filter(p => p[1] !== null);
  const s3 = f.dates.map((dt, i) => [dt, m3[i] === null ? null : m3[i] * 100]).filter(p => p[1] !== null);
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => p.map(x => `${x.seriesName}: ${fmt(x.value[1], 1)}%`).join("<br/>") },
    grid: baseGrid(), legend: { top: 0 },
    xAxis: { type: "time" }, yAxis: { type: "value", name: "最大回撤 (%)", max: 0 },
    dataZoom: [{ type: "inside" }],
    series: [
      { type: "line", name: "滚动1年", data: s1, showSymbol: false, lineStyle: { width: 1.4, color: DOWN } },
      { type: "line", name: "滚动3年", data: s3, showSymbol: false, lineStyle: { width: 1.4, color: "#7c3aed" } }
    ]
  }, true);
}
function underwaterInfo(d, f) {
  const long = currentData.longest_streaks;
  return `<table><thead><tr><th>项目</th><th>数值</th></tr></thead><tbody>
    <tr><td>最长连续未创新高（全历史）</td><td>${long.longest_underwater_days} 个交易日（${long.longest_underwater_start} ~ ${long.longest_underwater_end}）</td></tr>
    <tr><td>区间回撤 ≤ -5% / -10% / -20% 交易日占比</td><td>见上方 KPI</td></tr>
    <tr><td>区间重大回撤事件数（≤ -5%）</td><td>已列于上表</td></tr>
  </tbody></table>`;
}
function bindP03(f) {
  $("#log-toggle").onchange = (e) => { logScale = e.target.checked; drawPrice(f); };
}

// ---------------- P0-4 持有期收益 ----------------
function renderP04() {
  const d = currentData, f = filteredData();
  const horizons = [5, 20, 60, 120, 250, 500];
  const hData = horizons.map(h => holdingReturns(f.close, h)).filter(x => x.n > 0);
  const c = $("#content");
  c.innerHTML = `
    <div class="section-title">P0-4 不同持有期限下的历史收益率分布及亏损风险</div>
    <div class="module-intro"><b>研究问题</b>：随机在历史某个交易日买入并持有 5/20/60/120/250/500 个交易日，盈利/亏损概率、幅度和最差结果如何变化？</div>
    <div class="note misread"><b>重叠窗口警示</b>：连续滚动的持有期收益高度相关，不是独立投资实验；盈利比例只是历史滚动起点的频率，不代表明年盈利概率。</div>
    <div class="card" style="margin-top:12px">
      <h3>图 A：不同持有期限的收益分布（箱线）</h3>
      <div class="sub">持有期单位为交易日（252≈1年，仅年化约定）</div>
      <div id="p04-box" class="chart tall"></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>图 B：盈利 / 亏损比例</h3>
        <div class="sub">随持有期延长的胜率与亏损风险变化</div>
        <div id="p04-win" class="chart tall"></div>
      </div>
      <div class="card">
        <h3>图 C：选定持有期的收益分布直方图</h3>
        <div class="ctrl-row"><label>持有期 <select id="p04-horizon">${horizons.map(h => `<option value="${h}" ${h === holdingHorizon ? "selected" : ""}>${h} 交易日</option>`).join("")}</select></label></div>
        <div id="p04-hist" class="chart tall"></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>各持有期限汇总表</h3>
      ${holdingTable(hData)}
    </div>
  `;
  drawHoldingBox(hData);
  drawHoldingWin(hData);
  drawHoldingHist(hData);
  $("#p04-horizon").onchange = (e) => { holdingHorizon = parseInt(e.target.value); drawHoldingHist(hData); };
}
function drawHoldingBox(hData) {
  const c = getChart("p04-box");
  const data = hData.map(h => {
    const s = sortedCopy(h.returns_pct);
    const q1 = quantile(s, 25), med = quantile(s, 50), q3 = quantile(s, 75);
    const iqr = q3 - q1, lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
    return [lower, q1, med, q3, upper];
  });
  c.setOption({
    tooltip: { trigger: "item", formatter: (p) => { const d = p.data; const h = hData[p.dataIndex]; return `${h.horizon} 交易日<br/>上须 ${fmt(d[4])}<br/>Q3 ${fmt(d[3])}<br/>中位 ${fmt(d[2])}<br/>Q1 ${fmt(d[1])}<br/>下须 ${fmt(d[0])}`; } },
    grid: baseGrid(),
    xAxis: { type: "category", data: hData.map(h => h.horizon + "日") },
    yAxis: { type: "value", name: "持有期收益 (%)" },
    series: [{ type: "boxplot", data, itemStyle: { color: "#e0e7ff", borderColor: "#6366f1" } }]
  }, true);
}
function drawHoldingWin(hData) {
  const c = getChart("p04-win");
  const cats = hData.map(h => h.horizon + "日");
  const win = hData.map(h => h.win_rate_pct);
  const loss20 = hData.map(h => h.loss_gt20_pct);
  const loss10 = hData.map(h => h.loss_gt10_pct);
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(), legend: { top: 0 },
    xAxis: { type: "category", data: cats },
    yAxis: { type: "value", name: "%" },
    series: [
      { type: "bar", name: "盈利比例", data: win, itemStyle: { color: UP } },
      { type: "line", name: "亏损>10%比例", data: loss10, lineStyle: { color: DOWN } },
      { type: "line", name: "亏损>20%比例", data: loss20, lineStyle: { color: "#7c3aed", type: "dashed" } }
    ]
  }, true);
}
function drawHoldingHist(hData) {
  const c = getChart("p04-hist");
  const h = hData.find(x => x.horizon === holdingHorizon) || hData[0];
  if (!h) return;
  const s = sortedCopy(h.returns_pct);
  const hh = histogram(h.returns_pct, Math.max(1, (s[s.length - 1] - s[0]) / 40));
  const data = hh.centers.map((x, i) => ({ value: [x, hh.density[i]], count: hh.counts[i], n: h.returns_pct.length, bw: hh.bins[1] - hh.bins[0] }));
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => `${fmt(p[0].value[0], 1)}%<br/>频率 ${p[0].data.count} / ${p[0].data.n}<br/>密度 ${fmt(p[0].value[1], 4)}` },
    grid: baseGrid(),
    xAxis: { type: "value", name: "持有期收益 (%)" },
    yAxis: { type: "value", name: "概率密度" },
    series: [{ type: "bar", data, barWidth: "92%", itemStyle: { color: "#c7d2fe" } }]
  }, true);
}
function holdingTable(hData) {
  const rows = hData.map(h => `<tr>
    <td>${h.horizon}</td><td>${h.n}</td>
    <td class="up">${fmt(h.win_rate_pct, 1)}%</td>
    <td class="down">${fmt(h.loss_gt5_pct, 1)}%</td>
    <td class="down">${fmt(h.loss_gt10_pct, 1)}%</td>
    <td class="down">${fmt(h.loss_gt20_pct, 1)}%</td>
    <td>${fmt(h.median_pct, 1)}%</td>
    <td>${fmt(h.p5_pct, 1)}%</td>
    <td>${fmt(h.p95_pct, 1)}%</td>
    <td>${fmt(h.min_pct, 1)}%</td>
  </tr>`).join("");
  return `<table><thead><tr><th>持有期(交易日)</th><th>样本N</th><th>盈利%</th><th>亏>5%</th><th>亏>10%</th><th>亏>20%</th><th>中位数</th><th>P5</th><th>P95</th><th>最差</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------------- 数据状态 / 致命错误 ----------------
// ---------------- P1 市场广度与规模 ----------------
function renderP1Breadth() {
  const c = $("#content");
  if (!MARKET) {
    c.innerHTML = `<div class="section-title">P1-5/6 市场广度与规模结构</div><div class="card"><b>数据尚未生成</b><p>请运行 <code>python backend/stage23.py</code>（或 update_data.bat）后刷新。</p></div>`;
    return;
  }
  const m = MARKET, a = m.all;
  const upRatio = a.count ? a.up / a.count * 100 : 0;
  const top = m.concentration.top_share;
  const boardRows = m.boards.map(b => `<tr><td>${b.name}</td><td>${b.count}</td><td class="up">${b.up}</td><td class="down">${b.down}</td><td>${fmt(b.median_ret)}%</td><td>${fmt(b.total_cap_yi / 10000, 2)} 万亿</td></tr>`).join("");
  const capRows = m.cap_buckets.map(b => `<tr><td>${b.label}</td><td>${b.count}</td><td>${fmt(b.cap_yi / 10000, 2)} 万亿</td></tr>`).join("");
  const topRows = m.top_companies.map((t, i) => `<tr><td>${i + 1}</td><td>${t.name}</td><td>${fmt(t.cap_yi, 1)} 亿</td><td class="${t.zdf >= 0 ? "up" : "down"}">${fmt(t.zdf)}%</td></tr>`).join("");
  c.innerHTML = `
    <div class="section-title">P1-5/6 市场广度与规模结构（仅最新截面）</div>
    <div class="module-intro">研究问题：指数上涨时有多少股票实际下跌？大公司占多少市值？<b>数据边界</b>：本模块为<b>${m.as_of}</b> 的最新截面（${m.source}），<b>不是历史序列</b>；历史逐日广度需按日归档，本页不提供历史广度推断。</div>
    <div class="kpi-row">
      ${kpi("有效股票数", a.count, "只", `总市值 ${fmt(m.concentration.total_cap_yi / 10000, 1)} 万亿`)}
      ${kpi("上涨 / 下跌家数", `${a.up} / ${a.down}`, "", `平盘 ${a.flat}；涨跌幅中位 ${fmt(a.median_ret)}%`)}
      ${kpi("上涨家数占比", fmt(upRatio) + "%", upRatio >= 50 ? "up" : "down", "当日截面")}
      ${kpi("Top100 市值占比", fmt(top["100"] * 100) + "%", "", `Top10 ${fmt(top["10"] * 100)}%；Gini ${fmt(m.concentration.gini)}`)}
    </div>
    <div class="card"><h3>当日涨跌幅分布（家数）</h3><div class="sub">横轴区间；柱高为股票家数</div><div id="p1-hist" class="chart tall"></div></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>各板块涨跌家数</h3><div id="p1-boards" class="chart"></div>
        <table style="margin-top:8px"><thead><tr><th>板块</th><th>家数</th><th>涨</th><th>跌</th><th>中位</th><th>总市值</th></tr></thead><tbody>${boardRows}</tbody></table>
      </div>
      <div class="card"><h3>市值分布（家数）</h3><div id="p1-cap" class="chart"></div>
        <table style="margin-top:8px"><thead><tr><th>市值区间</th><th>家数</th><th>合计市值</th></tr></thead><tbody>${capRows}</tbody></table>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>洛伦兹曲线（市值集中度）</h3><div class="sub">对角线=完全平均；越弯说明越集中</div><div id="p1-lorenz" class="chart"></div></div>
      <div class="card"><h3>市值最大的 20 家公司</h3><div id="p1-top"><table><thead><tr><th>#</th><th>公司</th><th>总市值</th><th>涨跌</th></tr></thead><tbody>${topRows}</tbody></table></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>当前 PE / PB 中位数</h3>
      <div>PE_TTM 中位数 <b>${fmt(m.pe_pb_median.pe_ttm_median)}</b>（样本 ${m.pe_pb_median.pe_sample}）；PB 中位数 <b>${fmt(m.pe_pb_median.pb_median)}</b>（样本 ${m.pe_pb_median.pb_sample}）。中位数只描述当前截面，不是历史估值分位。</div>
      <div class="note misread"><b>容易误读：</b>${m.note}</div>
    </div>`;
  drawP1Hist(m);
  drawP1Boards(m);
  drawP1Cap(m);
  drawP1Lorenz(m);
}
function drawP1Hist(m) {
  const c = getChart("p1-hist");
  const bins = m.hist.bins, counts = m.hist.counts;
  const cats = bins.slice(0, -1).map((b, i) => `${b}~${bins[i + 1]}`);
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(),
    xAxis: { type: "category", data: cats, axisLabel: { rotate: 30, fontSize: 10 } },
    yAxis: { type: "value", name: "家数" },
    series: [{ type: "bar", data: counts.map((v, i) => ({ value: v, itemStyle: { color: parseFloat(cats[i]) >= 0 ? UP : DOWN } })) }]
  }, true);
}
function drawP1Boards(m) {
  const c = getChart("p1-boards");
  // 截断负值区间显示（hist 的最后一个区间是 7~11）
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(), legend: { top: 0 },
    xAxis: { type: "category", data: m.boards.map(b => b.name) },
    yAxis: { type: "value", name: "家数" },
    series: [
      { type: "bar", name: "上涨", data: m.boards.map(b => b.up), itemStyle: { color: UP } },
      { type: "bar", name: "下跌", data: m.boards.map(b => b.down), itemStyle: { color: DOWN } }
    ]
  }, true);
}
function drawP1Cap(m) {
  const c = getChart("p1-cap");
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(),
    xAxis: { type: "category", data: m.cap_buckets.map(b => b.label), axisLabel: { rotate: 20, fontSize: 10 } },
    yAxis: { type: "value", name: "家数" },
    series: [{ type: "bar", data: m.cap_buckets.map(b => b.count), itemStyle: { color: "#6366f1" } }]
  }, true);
}
function drawP1Lorenz(m) {
  const c = getChart("p1-lorenz");
  const lor = m.concentration.lorenz;
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => `累计${fmt(p[0].value[0] * 100, 1)}%的股票<br/>拥有 ${fmt(p[0].value[1] * 100, 1)}% 的市值` },
    grid: baseGrid(),
    xAxis: { type: "value", name: "股票数累计占比", max: 1, axisLabel: { formatter: v => (v * 100) + "%" } },
    yAxis: { type: "value", name: "市值累计占比", max: 1, axisLabel: { formatter: v => (v * 100) + "%" } },
    series: [
      { type: "line", name: "洛伦兹曲线", data: lor, showSymbol: false, lineStyle: { width: 2, color: "#2563eb" } },
      { type: "line", name: "完全平均", data: [[0, 0], [1, 1]], showSymbol: false, lineStyle: { type: "dashed", color: "#94a3b8" } }
    ]
  }, true);
}

// ---------------- P1-7 成交与流动性 ----------------
function renderP1Liquid() {
  const c = $("#content");
  if (!LIQUIDITY || !LIQUIDITY.indices || !LIQUIDITY.indices.length) {
    c.innerHTML = `<div class="section-title">P1-7 成交与流动性</div><div class="card"><b>数据尚未生成</b><p>请运行 <code>python backend/stage23.py</code>。</p></div>`;
    return;
  }
  const idx = LIQUIDITY.indices;
  const primary = idx[0];
  const last = lastNonNull(primary.amount_yi);
  const sorted = primary.amount_yi.filter(x => x !== null).sort((a, b) => a - b);
  const pct = last !== null ? mean(sorted.map(x => x <= last ? 1 : 0)) * 100 : NaN;
  const med252 = medianOf(primary.amount_yi.slice(-252));
  c.innerHTML = `
    <div class="section-title">P1-7 流动性、成交额与市场热度</div>
    <div class="module-intro">研究问题：今天的成交额到底算大还是小？放量是否意味着更高波动？<b>口径</b>：${LIQUIDITY.note}</div>
    <div class="kpi-row">
      ${kpi(`${primary.name}最新成交额`, fmt(last / 10000, 2) + " 万亿", "", "亿元口径换算")}
      ${kpi("该序列历史百分位", fmt(pct) + "%", pct >= 80 ? "up" : "", "同日成交额的历史分位")}
      ${kpi("近252日中位数", fmt(med252 / 10000, 2) + " 万亿", "", "与最新值比较")}
      ${kpi("最新/中位数比值", med252 ? fmt(last / med252) + "x" : "—", "", ">1 表示高于近一年中位数")}
    </div>
    <div class="card"><h3>指数成交额历史（亿元）</h3><div id="p1-amt" class="chart tall"></div></div>
    <div class="card" style="margin-top:14px"><h3>成交额历史分位（全部 & 近252日滚动）</h3><div id="p1-amtpct" class="chart"></div></div>
    <div class="note misread" style="margin-top:14px"><b>容易误读：</b>指数成分股成交额 ≠ 沪深全市场成交额；市值扩张会使不同年份的绝对成交额不可比。本页不推断成交额能预测收益。</div>`;
  drawAmount(idx);
  drawAmountPct(primary);
}
function lastNonNull(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i]; return null; }
function medianOf(arr) {
  const v = arr.filter(x => x !== null && x !== undefined);
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  return quantile(s, 50);
}
function drawAmount(indices) {
  const c = getChart("p1-amt");
  const series = indices.map((it, i) => ({
    type: "line", name: it.name, data: it.dates.map((d, j) => [d, it.amount_yi[j]]),
    showSymbol: false, lineStyle: { width: 1.2, color: PALETTE[i % PALETTE.length] }
  }));
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => `${p[0].value[0]}<br/>成交额 ${fmt(p[0].value[1], 1)} 亿元` },
    grid: baseGrid(), legend: { top: 0, type: "scroll" },
    xAxis: { type: "time" }, yAxis: { type: "value", name: "成交额（亿元）" },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6 }],
    series
  }, true);
}
function drawAmountPct(it) {
  const c = getChart("p1-amtpct");
  const vals = it.amount_yi;
  const pctAll = [], pct252 = [];
  const sortedAll = vals.filter(x => x !== null).slice().sort((a, b) => a - b);
  // 滚动252日分位
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null) { pctAll.push([it.dates[i], null]); pct252.push([it.dates[i], null]); continue; }
    pctAll.push([it.dates[i], mean(sortedAll.map(x => x <= vals[i] ? 1 : 0)) * 100]);
    const w = vals.slice(Math.max(0, i - 251), i + 1).filter(x => x !== null).sort((a, b) => a - b);
    pct252.push([it.dates[i], w.length ? mean(w.map(x => x <= vals[i] ? 1 : 0)) * 100 : null]);
  }
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(), legend: { top: 0 },
    xAxis: { type: "time" }, yAxis: { type: "value", name: "分位 (%)", min: 0, max: 100 },
    dataZoom: [{ type: "inside" }],
    series: [
      { type: "line", name: "全历史分位", data: pctAll, showSymbol: false, lineStyle: { width: 1.2, color: "#0f766e" } },
      { type: "line", name: "滚动252日分位", data: pct252, showSymbol: false, lineStyle: { width: 1.2, color: "#b45309" } }
    ]
  }, true);
}

// ---------------- P2 估值与行业 ----------------
function renderP2Value() {
  const c = $("#content");
  if (!VALUATION && !INDUSTRY) {
    c.innerHTML = `<div class="section-title">P2-8/9 估值与行业</div><div class="card"><b>正在加载或数据尚未生成</b><p>请稍候；若长时间空白，运行 <code>python backend/stage23.py</code> 后刷新。</p></div>`;
    ensureIndustry("p2value");
    return;
  }
  if (!INDUSTRY) ensureIndustry("p2value");
  ensureP2Indices();
  const primaryVal = VALUATION ? (VALUATION.indices.find(x => x.key === currentKey) || VALUATION.indices[0]) : null;
  const peNow = primaryVal ? lastPeValue(primaryVal) : null;
  const pePctAll = primaryVal && peNow !== null ? pePercentile(primaryVal, peNow, "all") : null;
  const pePct5 = primaryVal && peNow !== null ? pePercentile(primaryVal, peNow, "5y") : null;
  const indMedPe = INDUSTRY ? medianOf(INDUSTRY.industries.map(x => x.pe_ttm).filter(v => isFinite(v) && v > 0)) : null;
  const focusTxt = p2Focus.size ? `已筛选 ${p2Focus.size} 个重点行业（点击按钮取消）` : "点击按钮只看重点行业";
  c.innerHTML = `
    <div class="section-title">P2-8/9 估值、行业轮动与风格</div>
    <div class="module-intro">研究问题：市场/行业现在估值处于什么历史位置？价格来自盈利还是估值？哪些行业何时强弱、是否会同时下跌？<b>口径</b>：${VALUATION ? VALUATION.note : ""}</div>
    ${p2DataBanner()}
    <div class="kpi-row">
      ${kpi(`${primaryVal ? primaryVal.name : "指数"} 最新 PE_TTM`, peNow === null ? "—" : fmt(peNow), "", primaryVal ? primaryVal.dates[primaryVal.dates.length - 1] : "")}
      ${kpi("PE 全历史分位", pePctAll === null ? "—" : fmtPct(pePctAll), pePctAll !== null && pePctAll >= 70 ? "down" : "", "越高代表越贵（相对自身历史）")}
      ${kpi("PE 近 5 年分位", pePct5 === null ? "—" : fmtPct(pePct5), "", "仅用截至该日的过去 5 年")}
      ${kpi("申万一级行业 PE 中位数", indMedPe === null ? "—" : fmt(indMedPe), "", "31 个行业最新截面，剔除负 PE")}
    </div>
    <div class="card">
      <h3>重点行业快捷筛选</h3>
      <div class="sub">${focusTxt}；筛选同时作用于下方行业 PE / PB / 股息率三张截面图</div>
      <div class="ctrl-row" id="p2-focus">${P2_FOCUS.map(n => `<button class="btn p2-fbtn ${p2Focus.has(n) ? "active" : ""}" data-name="${n}">${n}</button>`).join("")}
        <button class="btn" id="p2-fclear">全部行业</button></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>指数滚动市盈率 PE_TTM 历史（含 5 年滚动分位带）</h3><div class="sub">实线为各指数 PE_TTM；虚线带为该指数过去 5 年 PE 的 P20/P50/P80（月末采样，仅用当时已知历史）</div><div id="p2-pe" class="chart tall"></div></div>
    <div class="card" style="margin-top:14px"><h3>当前 PE 处于历史什么位置（5 年 / 10 年 / 全历史分位）</h3><div class="sub">分位 = 截至最新交易日，当前 PE 在该窗口历史 PE 中的经验百分位；越高越贵</div><div id="p2-pepct" class="chart"></div></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>申万一级行业当前 PE_TTM</h3><div class="sub">按 PE 从低到高排序；仅最新截面</div><div id="p2-indpe" class="chart tall"></div></div>
      <div class="card"><h3>申万一级行业当前 PB</h3><div class="sub">按 PB 从低到高排序；仅最新截面</div><div id="p2-indpb" class="chart tall"></div></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>申万一级行业当前股息率</h3><div class="sub">按股息率从高到低排序；仅最新截面</div><div id="p2-inddiv" class="chart tall"></div></div>
      <div class="card"><h3>31 个行业 PE 截面分布（箱线）</h3><div class="sub">箱体为四分位、须为 1.5 倍 IQR，点是离群行业；剔除负 PE</div><div id="p2-indbox" class="chart tall"></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>行业年度收益热力图</h3><div class="sub">每个行业每年的价格收益（%）</div><div id="p2-indyear" class="chart tall"></div></div>
    <div class="card" style="margin-top:14px"><h3>行业相对沪深300 的年度超额收益</h3><div class="sub">行业当年价格收益 − 沪深300 同年价格收益（百分点）；红色跑赢、绿色跑输</div><div id="p2-excess" class="chart tall"></div></div>
    <div class="card" style="margin-top:14px"><h3>主要指数累计收益（起点 = 100）</h3><div class="sub">沪深300 / 上证50 / 中证500 / 中证1000，统一从共同起点归一；价格为指数口径，不含分红</div><div id="p2-cumidx" class="chart tall"></div></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>大小盘相对强弱（上证50 / 中证1000）</h3><div class="sub">比值上行=大盘风格占优；下行=小盘占优；起点归一为 1</div><div id="p2-style" class="chart"></div></div>
      <div class="card"><h3>行业与沪深300 的联动性</h3><div class="sub">31 个行业与沪深300 的滚动 60 日相关系数（行业平均）＋ 沪深300 滚动 250 日年化波动率</div><div id="p2-corr" class="chart"></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>行业近 1 年累计收益排名</h3><div class="sub">按最近 250 个交易日价格收益排序</div><div id="p2-indret" class="chart tall"></div></div>
    <div class="card" style="margin-top:14px"><h3>数据不足、本页不画的部分（如实标注，不用假数据填充）</h3>
      <ul class="sub" style="margin:6px 0 0 18px;line-height:1.9">
        <li><b>分板块估值箱线图（个股口径）：</b>现有数据只有全市场 PE/PB 中位数与行业当前值，没有个股估值历史分位，无法按板块计算，暂不绘制。</li>
        <li><b>行业估值历史分位：</b>申万行业只采集了当前 PE/PB/股息率与价格历史，缺少行业估值的历史序列，因此本页的行业估值只做截面比较，不做“历史分位”结论。</li>
        <li><b>盈利与估值分解：</b>需要可验证的历史盈利（EPS/ROE）序列，当前未采集，不做“涨了来自盈利还是估值”的定量拆解。</li>
        <li><b>分红全收益指数：</b>未取得可信的全收益指数序列，因此所有累计收益均为价格口径，不含分红。</li>
      </ul>
      <div class="note misread" style="margin-top:12px"><b>边界：</b>指数 PE 为样本口径、滚动市盈率；行业分类以申万为准；未把个股最新 PE 拼成“历史主板 PE”；分位均为经验分位，不是未来概率。</div>
    </div>`;
  drawPE();
  drawPePct();
  drawIndPE();
  drawIndPB();
  drawIndDiv();
  drawIndBox();
  drawIndYear();
  drawExcess();
  drawIndexCum();
  drawStyle();
  drawCorr();
  drawIndRet();
  bindP2Focus();
}
function drawPE() {
  if (!VALUATION) return chartNotice("p2-pe", "估值数据尚未加载完成，请稍候或刷新页面");
  const c = getChart("p2-pe");
  if (!c) return;
  const series = VALUATION.indices.map((it, i) => ({
    type: "line", name: it.name, data: it.dates.map((d, j) => [d, it.pe_ttm[j]]),
    showSymbol: false, lineStyle: { width: 1.2, color: PALETTE[i % PALETTE.length] }
  }));
  const primary = VALUATION.indices.find(x => x.key === currentKey) || VALUATION.indices[0];
  if (primary) {
    const band = peBand(primary);
    const bandColor = "#94a3b8";
    const mk = (name, data, dash) => ({
      type: "line", name, data, showSymbol: false, connectNulls: true,
      lineStyle: { width: 1, type: dash, color: bandColor }
    });
    series.push(
      mk(`${primary.name} 5年P20`, band.p20, "dotted"),
      mk(`${primary.name} 5年P50`, band.p50, "dashed"),
      mk(`${primary.name} 5年P80`, band.p80, "dotted")
    );
  }
  c.setOption({
    tooltip: { trigger: "axis", formatter: (p) => `${p[0].value[0]}<br/>PE ${fmt(p[0].value[1])}` },
    grid: baseGrid(), legend: { top: 0, type: "scroll" },
    xAxis: { type: "time" }, yAxis: { type: "value", name: "PE_TTM", scale: true },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6 }],
    series
  }, true);
}
function drawIndPE() {
  if (!INDUSTRY) return chartNotice("p2-indpe", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-indpe");
  if (!c) return;
  const list = focusFilter(INDUSTRY.industries.filter(x => isFinite(x.pe_ttm) && x.pe_ttm > 0))
    .sort((a, b) => a.pe_ttm - b.pe_ttm);
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 90, right: 24, top: 16, bottom: 40 },
    xAxis: { type: "value", name: "PE_TTM" },
    yAxis: { type: "category", data: list.map(x => x.name), axisLabel: { fontSize: 10 } },
    series: [{ type: "bar", data: list.map(x => ({ value: x.pe_ttm, itemStyle: { color: p2Focus.has(x.name) ? "#b45309" : "#6366f1" } })) }]
  }, true);
}
function drawIndPB() {
  if (!INDUSTRY) return chartNotice("p2-indpb", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-indpb");
  if (!c) return;
  const list = focusFilter(INDUSTRY.industries.filter(x => isFinite(x.pb) && x.pb > 0)).sort((a, b) => a.pb - b.pb);
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 90, right: 24, top: 16, bottom: 40 },
    xAxis: { type: "value", name: "PB" },
    yAxis: { type: "category", data: list.map(x => x.name), axisLabel: { fontSize: 10 } },
    series: [{ type: "bar", data: list.map(x => ({ value: x.pb, itemStyle: { color: p2Focus.has(x.name) ? "#b45309" : "#0891b2" } })) }]
  }, true);
}
function industryYearly(close, dates) {
  // 返回 [{year, ret}]，按自然年首末收盘
  const map = {};
  for (let i = 0; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    if (!map[y]) map[y] = { first: close[i], last: close[i] };
    else map[y].last = close[i];
  }
  return Object.keys(map).sort().map(y => ({ year: y, ret: (map[y].last / map[y].first - 1) * 100 }));
}
function drawIndYear() {
  if (!INDUSTRY) return chartNotice("p2-indyear", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-indyear");
  const inds = INDUSTRY.industries.filter(x => x.dates.length > 30);
  const years = [...new Set(inds.flatMap(x => industryYearly(x.close, x.dates).map(y => y.year)))].sort().slice(-12);
  const data = [];
  let vmax = 0;
  inds.forEach((it, yi) => {
    const ym = {};
    industryYearly(it.close, it.dates).forEach(o => { ym[o.year] = o.ret; });
    years.forEach((y, xi) => {
      if (ym[y] !== undefined) { data.push([xi, yi, ym[y]]); vmax = Math.max(vmax, Math.abs(ym[y])); }
    });
  });
  c.setOption({
    tooltip: { formatter: (p) => `${inds[p.value[1]].name} ${years[p.value[0]]}<br/>收益 ${fmt(p.value[2], 1)}%` },
    grid: { left: 90, right: 24, top: 16, bottom: 40 },
    xAxis: { type: "category", data: years, axisLabel: { fontSize: 10 } },
    yAxis: { type: "category", data: inds.map(x => x.name), axisLabel: { fontSize: 10 } },
    visualMap: { min: -vmax, max: vmax, calculable: true, orient: "horizontal", left: "center", bottom: 0, inRange: { color: ["#1a9e6c", "#ffffff", "#d64541"] }, textStyle: { fontSize: 10 } },
    dataZoom: [{ type: "inside", yAxisIndex: 0 }],
    series: [{ type: "heatmap", data, label: { show: false }, emphasis: { itemStyle: { shadowBlur: 6 } } }]
  }, true);
}
function drawIndRet() {
  if (!INDUSTRY) return chartNotice("p2-indret", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-indret");
  const rows = [];
  INDUSTRY.industries.forEach(it => {
    if (!it.dates.length) return;
    // 近1年：取最后一年交易日
    const n = it.dates.length;
    const span = Math.min(250, n - 1);
    if (span <= 5) return;
    const ret = (it.close[n - 1] / it.close[n - 1 - span] - 1) * 100;
    rows.push({ name: it.name, ret });
  });
  rows.sort((a, b) => a.ret - b.ret);
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 90, right: 24, top: 16, bottom: 40 },
    xAxis: { type: "value", name: "近1年收益 (%)" },
    yAxis: { type: "category", data: rows.map(r => r.name), axisLabel: { fontSize: 10 } },
    series: [{ type: "bar", data: rows.map(r => ({ value: r.ret, itemStyle: { color: r.ret >= 0 ? UP : DOWN } })) }]
  }, true);
}

// ---------------- P2 补全：估值分位、行业轮动、风格与相关性 ----------------
const P2_FOCUS = ["银行", "非银金融", "有色金属", "石油石化", "基础化工", "纺织服饰", "食品饮料", "医药生物"];
let p2Focus = new Set();
let p2IndicesTried = false;
const P2_CACHE = { corr: null, cumidx: null, style: null };

async function ensureP2Indices() {
  const need = ["sh000300", "sh000016", "sh000905", "sh000852"];
  const missing = need.filter(k => !dataMap[k]);
  if (!missing.length || p2IndicesTried) return;
  p2IndicesTried = true;
  await ensureLoaded(missing);
  if (activeModule === "p2value") renderAll();
}

function lastPeValue(idx) {
  const v = idx.pe_ttm;
  for (let i = v.length - 1; i >= 0; i--) if (v[i] !== null && v[i] !== undefined && isFinite(v[i])) return v[i];
  return null;
}
function peWindowValues(idx, win) {
  const lastDate = idx.dates[idx.dates.length - 1];
  let start = null;
  if (win === "5y") start = shiftDate(lastDate, -5);
  else if (win === "10y") start = shiftDate(lastDate, -10);
  const out = [];
  for (let i = 0; i < idx.dates.length; i++) {
    if (start && idx.dates[i] < start) continue;
    const v = idx.pe_ttm[i];
    if (v !== null && v !== undefined && isFinite(v)) out.push(v);
  }
  return out;
}
function pePercentile(idx, value, win) {
  const v = peWindowValues(idx, win);
  if (!v.length || value === null) return null;
  return mean(v.map(x => (x <= value ? 1 : 0))) * 100;
}
function peBand(idx) {
  // 月末采样；每个采样点回看 5 年 PE 求 P20/P50/P80（只用当时已知历史）
  const p20 = [], p50 = [], p80 = [];
  const d = idx.dates, v = idx.pe_ttm;
  for (let i = 0; i < d.length; i++) {
    const isMonthEnd = i === d.length - 1 || d[i + 1].slice(0, 7) !== d[i].slice(0, 7);
    if (!isMonthEnd) continue;
    const winVals = [];
    const from = shiftDate(d[i], -5);
    for (let j = i; j >= 0 && d[j] >= from; j--) {
      const x = v[j];
      if (x !== null && x !== undefined && isFinite(x)) winVals.push(x);
    }
    if (winVals.length < 40) continue;
    const s = sortedCopy(winVals);
    p20.push([d[i], quantile(s, 20)]);
    p50.push([d[i], quantile(s, 50)]);
    p80.push([d[i], quantile(s, 80)]);
  }
  return { p20, p50, p80 };
}
function drawPePct() {
  if (!VALUATION) return chartNotice("p2-pepct", "估值数据尚未加载完成，请稍候或刷新页面");
  const c = getChart("p2-pepct");
  if (!c) return;
  const names = [], s5 = [], s10 = [], sAll = [];
  for (const it of VALUATION.indices) {
    const now = lastPeValue(it);
    names.push(it.name);
    s5.push(now === null ? null : pePercentile(it, now, "5y"));
    s10.push(now === null ? null : pePercentile(it, now, "10y"));
    sAll.push(now === null ? null : pePercentile(it, now, "all"));
  }
  c.setOption({
    tooltip: { trigger: "axis", valueFormatter: (x) => (x === null || x === undefined ? "—" : fmt(x) + "%") },
    grid: { left: 56, right: 24, top: 34, bottom: 40 },
    legend: { top: 0 },
    xAxis: { type: "category", data: names, axisLabel: { fontSize: 11 } },
    yAxis: { type: "value", name: "历史分位 (%)", min: 0, max: 100 },
    series: [
      { type: "bar", name: "近 5 年分位", data: s5, itemStyle: { color: "#2563eb" } },
      { type: "bar", name: "近 10 年分位", data: s10, itemStyle: { color: "#7c3aed" } },
      { type: "bar", name: "全历史分位", data: sAll, itemStyle: { color: "#b45309" } }
    ]
  }, true);
}
function focusFilter(list) {
  return p2Focus.size ? list.filter(x => p2Focus.has(x.name)) : list;
}
function p2DataBanner() {
  if (INDUSTRY && VALUATION) return "";
  if (industryLoadError) {
    return `<div class="card" style="border-color:#f59e0b;background:#fffbeb"><b>行业数据加载失败：</b>${escapeHtml(industryLoadError)}　<button class="btn" id="p2-retry">重试</button>　也可运行 <code>python backend/stage23.py</code> 后刷新页面</div>`;
  }
  const parts = [];
  if (!VALUATION) parts.push("指数估值序列");
  if (!INDUSTRY) parts.push("申万行业序列（industry.json 约 4.4MB，首次加载需要几秒）");
  return `<div class="card"><b>正在加载：</b>${parts.join("、")}。相关图区先显示占位说明，加载完成后自动重绘。</div>`;
}
function drawIndDiv() {
  if (!INDUSTRY) return chartNotice("p2-inddiv", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-inddiv");
  if (!c) return;
  const list = focusFilter(INDUSTRY.industries.filter(x => isFinite(x.div_yield) && x.div_yield > 0))
    .sort((a, b) => b.div_yield - a.div_yield);
  const hi = list.map(x => x.div_yield);
  c.setOption({
    tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) + "%" },
    grid: { left: 90, right: 24, top: 16, bottom: 40 },
    xAxis: { type: "value", name: "股息率 (%)" },
    yAxis: { type: "category", data: list.map(x => x.name), axisLabel: { fontSize: 10 } },
    series: [{ type: "bar", data: list.map((x, i) => ({ value: hi[i], itemStyle: { color: p2Focus.has(x.name) ? "#b45309" : "#0f766e" } })) }]
  }, true);
}
function drawIndBox() {
  if (!INDUSTRY) return chartNotice("p2-indbox", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-indbox");
  if (!c) return;
  const pool = INDUSTRY.industries.filter(x => isFinite(x.pe_ttm) && x.pe_ttm > 0);
  const vals = pool.map(x => x.pe_ttm);
  if (vals.length < 4) { c.setOption({ title: { text: "样本不足，无法绘制箱线", left: "center", top: "middle", textStyle: { fontSize: 13, color: "#94a3b8" } } }, true); return; }
  const s = sortedCopy(vals);
  const q1 = quantile(s, 25), med = quantile(s, 50), q3 = quantile(s, 75);
  const iqr = q3 - q1;
  const lo = Math.min(...s.filter(v => v >= q1 - 1.5 * iqr));
  const hi = Math.max(...s.filter(v => v <= q3 + 1.5 * iqr));
  const outliers = pool.filter(x => x.pe_ttm < lo || x.pe_ttm > hi)
    .map(x => ({ name: x.name, value: x.pe_ttm }));
  c.setOption({
    tooltip: { trigger: "item" },
    grid: { left: 56, right: 90, top: 30, bottom: 34 },
    xAxis: { type: "category", data: ["申万31行业 PE_TTM"], axisLabel: { fontSize: 11 } },
    yAxis: { type: "value", name: "PE_TTM", scale: true },
    series: [
      { type: "boxplot", data: [[lo, q1, med, q3, hi]], boxWidth: 60, itemStyle: { color: "#e0e7ff", borderColor: "#4f46e5" } },
      {
        type: "scatter", data: outliers.map(o => [0, o.value]), symbolSize: 7,
        itemStyle: { color: "#b45309" },
        label: { show: true, formatter: (p) => outliers[p.dataIndex].name, position: "right", fontSize: 10 }
      }
    ]
  }, true);
}
function yearReturnMap(dates, close) {
  const m = {};
  for (let i = 0; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    if (!m[y]) m[y] = { first: close[i], last: close[i] };
    else m[y].last = close[i];
  }
  const out = {};
  for (const y of Object.keys(m)) out[y] = (m[y].last / m[y].first - 1) * 100;
  return out;
}
function drawExcess() {
  if (!INDUSTRY) return chartNotice("p2-excess", "行业数据尚未加载完成（industry.json 约 4.4MB），请稍候或点上方重试");
  const c = getChart("p2-excess");
  if (!c) return;
  const hs = dataMap["sh000300"];
  if (!hs) {
    c.setOption({ title: { text: "沪深300 统计序列未加载，暂不计算超额收益", left: "center", top: "middle", textStyle: { fontSize: 13, color: "#94a3b8" } } }, true);
    return;
  }
  const hsYear = yearReturnMap(hs.dates, hs.close);
  const inds = focusFilter(INDUSTRY.industries.filter(x => x.dates.length > 60));
  const years = [...new Set(inds.flatMap(x => Object.keys(yearReturnMap(x.dates, x.close))))]
    .filter(y => hsYear[y] !== undefined).sort().slice(-12);
  const data = [];
  let vmax = 0;
  inds.forEach((it, yi) => {
    const ym = yearReturnMap(it.dates, it.close);
    years.forEach((y, xi) => {
      if (ym[y] === undefined) return;
      const ex = ym[y] - hsYear[y];
      data.push([xi, yi, ex]);
      vmax = Math.max(vmax, Math.abs(ex));
    });
  });
  c.setOption({
    tooltip: { formatter: (p) => `${inds[p.value[1]].name} ${years[p.value[0]]}<br/>超额 ${fmt(p.value[2], 1)} 个百分点` },
    grid: { left: 90, right: 24, top: 16, bottom: 40 },
    xAxis: { type: "category", data: years, axisLabel: { fontSize: 10 } },
    yAxis: { type: "category", data: inds.map(x => x.name), axisLabel: { fontSize: 10 } },
    visualMap: { min: -vmax, max: vmax, calculable: true, orient: "horizontal", left: "center", bottom: 0, inRange: { color: ["#1a9e6c", "#ffffff", "#d64541"] }, textStyle: { fontSize: 10 } },
    dataZoom: [{ type: "inside", yAxisIndex: 0 }],
    series: [{ type: "heatmap", data, emphasis: { itemStyle: { shadowBlur: 6 } } }]
  }, true);
}
function commonSeries(keys) {
  const series = keys.map(k => dataMap[k]).filter(Boolean);
  if (series.length < 2) return null;
  const starts = series.map(s => s.dates[0]).sort();
  const start = starts[starts.length - 1];
  const maps = series.map(s => {
    const m = new Map();
    for (let i = 0; i < s.dates.length; i++) m.set(s.dates[i], s.close[i]);
    return m;
  });
  const dates = series[0].dates.filter(d => d >= start && maps.every(m => m.has(d)));
  return { dates, maps, names: series.map(s => s.name), raw: series };
}
function drawIndexCum() {
  const c = getChart("p2-cumidx");
  if (!c) return;
  const keys = ["sh000300", "sh000016", "sh000905", "sh000852"];
  const cs = commonSeries(keys);
  if (!cs) {
    c.setOption({ title: { text: "指数统计序列未加载", left: "center", top: "middle", textStyle: { fontSize: 13, color: "#94a3b8" } } }, true);
    return;
  }
  const series = cs.maps.map((m, i) => {
    const base = m.get(cs.dates[0]);
    return {
      type: "line", name: cs.names[i], showSymbol: false,
      data: cs.dates.map(d => [d, (m.get(d) / base) * 100]),
      lineStyle: { width: 1.4, color: PALETTE[i % PALETTE.length] }
    };
  });
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: baseGrid(), legend: { top: 0, type: "scroll" },
    xAxis: { type: "time" }, yAxis: { type: "value", name: "累计净值（起点=100）", scale: true },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6 }],
    series
  }, true);
}
function drawStyle() {
  const c = getChart("p2-style");
  if (!c) return;
  const cs = commonSeries(["sh000016", "sh000852"]);
  if (!cs) {
    c.setOption({ title: { text: "上证50 / 中证1000 序列未加载", left: "center", top: "middle", textStyle: { fontSize: 13, color: "#94a3b8" } } }, true);
    return;
  }
  const [big, small] = cs.maps;
  const base = big.get(cs.dates[0]) / small.get(cs.dates[0]);
  const pts = cs.dates.map(d => [d, (big.get(d) / small.get(d)) / base]);
  c.setOption({
    tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v, 3) },
    grid: baseGrid(),
    xAxis: { type: "time" },
    yAxis: { type: "value", name: "相对强弱（起点=1）", scale: true },
    dataZoom: [{ type: "inside" }],
    series: [{ type: "line", name: "上证50 / 中证1000", data: pts, showSymbol: false, lineStyle: { width: 1.5, color: "#7c3aed" }, areaStyle: { opacity: 0.06 } }]
  }, true);
}
function pearson(pairs) {
  const n = pairs.length;
  if (n < 3) return NaN;
  let sx = 0, sy = 0;
  for (const [a, b] of pairs) { sx += a; sy += b; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [a, b] of pairs) { const dx = a - mx, dy = b - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}
function corrSeries() {
  if (P2_CACHE.corr) return P2_CACHE.corr;
  const hs = dataMap["sh000300"];
  if (!hs || !INDUSTRY) return null;
  const hsRet = new Map();
  hs.returns_dates.forEach((d, i) => hsRet.set(d, hs.returns_pct[i]));
  const indRets = INDUSTRY.industries.map(it => {
    const m = new Map();
    for (let i = 1; i < it.close.length; i++) m.set(it.dates[i], (it.close[i] / it.close[i - 1] - 1) * 100);
    return m;
  }).filter(m => m.size > 120);
  const dates = hs.returns_dates;
  const samples = [];
  for (let i = 0; i < dates.length; i++) {
    if (i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7)) samples.push(i);
  }
  const corr = [], vol = [];
  const win = 60;
  for (const i of samples) {
    if (i + 1 < win) continue;
    const ref = dates.slice(i - win + 1, i + 1);
    const cs = [];
    for (const m of indRets) {
      const pairs = [];
      for (const d of ref) {
        const a = m.get(d), b = hsRet.get(d);
        if (a !== undefined && b !== undefined) pairs.push([a, b]);
      }
      if (pairs.length >= win * 0.6) {
        const r = pearson(pairs);
        if (isFinite(r)) cs.push(r);
      }
    }
    corr.push([dates[i], cs.length ? mean(cs) : null]);
    const w250 = dates.slice(Math.max(0, i - 249), i + 1).map(d => hsRet.get(d)).filter(v => v !== undefined);
    vol.push([dates[i], w250.length > 60 ? sampleStd(w250) * Math.sqrt(252) : null]);
  }
  P2_CACHE.corr = { corr, vol };
  return P2_CACHE.corr;
}
function drawCorr() {
  const c = getChart("p2-corr");
  if (!c) return;
  const r = corrSeries();
  if (!r || !r.corr.length) {
    c.setOption({ title: { text: "相关性所需序列（行业收益 + 沪深300）未就绪", left: "center", top: "middle", textStyle: { fontSize: 13, color: "#94a3b8" } } }, true);
    return;
  }
  c.setOption({
    tooltip: { trigger: "axis" },
    grid: { left: 56, right: 56, top: 34, bottom: 44 },
    legend: { top: 0 },
    xAxis: { type: "time" },
    yAxis: [
      { type: "value", name: "相关系数", min: -0.2, max: 1, axisLabel: { formatter: (v) => fmt(v, 1) } },
      { type: "value", name: "年化波动率 (%)", axisLabel: { formatter: (v) => fmt(v, 0) + "%" } }
    ],
    dataZoom: [{ type: "inside" }],
    series: [
      { type: "line", name: "行业平均相关系数(60日)", yAxisIndex: 0, data: r.corr, showSymbol: false, lineStyle: { width: 1.4, color: "#2563eb" } },
      { type: "line", name: "沪深300 年化波动率(250日)", yAxisIndex: 1, data: r.vol, showSymbol: false, lineStyle: { width: 1.2, color: "#b45309" } }
    ]
  }, true);
}
function bindP2Focus() {
  const clear = $("#p2-fclear");
  if (clear) clear.onclick = () => { p2Focus = new Set(); renderAll(); };
  const retry = $("#p2-retry");
  if (retry) retry.onclick = () => { retryIndustry(); renderAll(); };
  $$("#p2-focus .p2-fbtn").forEach(btn => {
    btn.onclick = () => {
      const n = btn.dataset.name;
      if (p2Focus.has(n)) p2Focus.delete(n); else p2Focus.add(n);
      renderAll();
    };
  });
}

function renderStatus() {
  const d = currentData;
  const el = $("#data-status");
  const ok = d.source_interface !== "unknown";
  el.innerHTML = `
    <div class="${ok ? "ok" : "warn"}">● ${ok ? "真实历史序列" : "数据状态未知"}</div>
    <div>${d.name}</div>
    <div>${d.first_date} ~ ${d.last_date}</div>
    <div>样本 N=${d.n}</div>
    <div>来源 ${d.source_interface}</div>
    <div>更新 ${(d.updated_at || "—").slice(0, 16).replace("T", " ")}</div>`;
}
function renderFatal(msg) {
  $("#content").innerHTML = `<div class="card"><b>启动提示</b><p>${escapeHtml(msg)}</p></div>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------------- 事件绑定 ----------------
function bindGlobal() {
  const btn = $("#picker-btn");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); $("#picker-panel").classList.toggle("hidden"); };
  document.addEventListener("click", (e) => {
    const panel = $("#picker-panel");
    if (panel && !panel.contains(e.target) && !e.target.closest("#picker-btn")) panel.classList.add("hidden");
  });
  $("#range-select").onchange = (e) => {
    range = e.target.value;
    $("#custom-range").classList.toggle("hidden", range !== "custom");
    if (range !== "custom") renderAll();
  };
  $("#apply-range").onclick = () => {
    customStart = $("#range-start").value || null;
    customEnd = $("#range-end").value || null;
    renderAll();
  };
  $("#export-csv").onclick = () => exportCSV();
  $$(".nav-item").forEach(b => b.onclick = () => switchModule(b.dataset.module));
  window.addEventListener("hashchange", () => applyModule((location.hash || "").replace("#", "") || "overview"));
  $("#story-next").onclick = () => {
    const order = ["overview", "p01", "p02", "p03", "p04", "p1breadth", "p1liquid", "p2value"];
    const i = order.indexOf(activeModule);
    switchModule(order[(i + 1) % order.length]);
  };
  // 事件委托：入口卡跳转
  $("#content").addEventListener("click", (e) => {
    const card = e.target.closest("[data-goto]");
    if (card) switchModule(card.dataset.goto);
  });
}
function downloadPng(chartId, name) {
  const c = charts[chartId];
  if (!c) return;
  const url = c.getDataURL({ pixelRatio: 2, backgroundColor: "#fff" });
  const a = document.createElement("a");
  a.href = url; a.download = name + ".png"; a.click();
}
function exportCSV() {
  if (!currentData) return;
  const f = filteredData();
  const closeMap = {};
  f.dates.forEach((d, i) => { closeMap[d] = f.close[i]; });
  const rows = ["date,close,return_pct"];
  f.returns.forEach((r, i) => {
    const d = f.returnsDates[i];
    const c = closeMap[d];
    rows.push(`${d},${c !== undefined ? c : ""},${r.toFixed(4)}`);
  });
  const csv = "\ufeff" + rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const name = `${currentKey}_daily_${f.returnsDates[0] || "none"}_${f.returnsDates[f.returnsDates.length - 1] || "none"}.csv`;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.addEventListener("DOMContentLoaded", () => { bindGlobal(); init(); });
