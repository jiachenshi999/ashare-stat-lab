# 数据源与环境审计（docs/data_source_audit.md）

> 生成日期：2026-11-22 · 项目：A股市场统计认知实验室 · 版本 V1.0

## 1. 运行环境实际版本

| 项目 | 实际值 | 说明 |
|------|--------|------|
| 操作系统 | Windows（ThinkPad X1 Carbon） | `$env:PROGRAMFILES = C:\Program Files` |
| Python | 3.12.14（无系统 Python） | 仅存在于 AkShare MCP 的 venv 中 |
| akshare | 1.20.65 | MCP venv 内 `site-packages` |
| akshare-one | 0.6.1 | MCP 行情封装库 |
| china-stock-mcp | 0.1.16 | 已安装的 MCP 服务器（pip 包） |
| fastmcp | 4.2.4 | MCP 框架（stdlib + fastmcp 实现） |
| mcp | 2.3.0 | MCP 协议库 |
| pandas | 3.1.1 | MCP venv |
| numpy | 2.5.5 | MCP venv |
| pyarrow | 26.0.1 | MCP venv（未使用） |
| uvicorn | 0.54.0 | MCP venv（本项目后端未使用，改用纯标准库） |
| scipy / fastapi / duckdb | 未安装 | 本项目的统计实现不依赖它们 |
| Node.js | 无系统 Node；DSH 自带 `dsh-primary-runtime\...\node.exe` | 仅用于 JS 冒烟测试 |
| 浏览器 | Microsoft Edge（可用于无头验收截图） | |

**结论**：本机没有系统级 Python，唯一可用的 akshare 环境在 `C:\Users\Lenovo\.dsh\mcp-servers\china-stock-mcp\venv`。本项目**复用该 venv 的 Python 解释器与 akshare**，未重复安装 akshare/pandas/numpy，符合"不重复安装已有工具"的要求。后端服务使用纯 Python 标准库（`http.server`），因此即使 akshare 升级或 MCP 迁移，页面服务与已缓存数据仍可运行。

## 2. Harness 中 AkShare MCP 的注册情况

- **接入方式**：Harness 通过 `dsch-bundles\china-stock-mcp\cordis.patch.yml` 注册，`transport: stdio`，命令为
  `C:\Users\Lenovo\.dsh\mcp-servers\china-stock-mcp\venv\Scripts\python.exe -m china_stock_mcp`。
- **本质**：不是官方 AKTools MCP，而是第三方 `china-stock-mcp`（PyPI 包 0.1.16），基于 **FastMCP** 封装 `akshare` 与 `akshare_one`。工具以 `mcp__china-stock__*` 形式暴露。
- **数据源**：优先东方财富（eastmoney），回退 eastmoney_direct / 新浪 / 雪球 / 同花顺等。

### 2.1 已注册工具清单（读取 server.py 实测）

行情/指标类：`get_hist_data`（→`akshare_one.get_hist_data`，**仅个股**）、`get_realtime_data`、`get_stock_volatility`、`get_stock_cyq`。
指数类：`get_all_cni_indices`（→`ak.index_all_cni`，**仅国证/深证指数**）、`get_cni_index_hist`（→`ak.index_hist_cni`）、`get_cni_index_detail`。
财务/公司类：`get_balance_sheet`、`get_income_statement`、`get_cash_flow`、`get_financial_metrics`、`get_stock_basic_info`、`get_shareholder_info`、`get_product_info`、`get_profit_forecast`、`get_stock_fhps_detail`、`get_stock_research_report`、`get_stock_circulate_stock_holder`、`get_stock_management_change`、`get_stock_restricted_release_queue`、`get_stock_value`、`get_stock_a_code_name`。
其它：`get_news_data`、`get_fund_flow`、`get_inner_trade_data`、`get_macro_data`、`get_investor_sentiment`、`get_time_info`、`get_stock_technical_rank`、`get_stock_board_industry_summary`。

### 2.2 关键实测发现

1. **MCP 没有上证指数历史接口**。`get_hist_data` 走 `akshare_one`（个股），`get_cni_index_hist` 走 `ak.index_hist_cni`（国证/深证）。上证指数（000001.SH）、沪深300（000300）、上证50（000016）、中证500/1000 等**不在** MCP 覆盖范围。因此本项目指数历史数据改为**直接用 akshare 调用**（`index_zh_daily_sina`），MCP 仅作为"已安装 akshare 环境"的来源确认。
2. **`get_time_info` 已损坏**。其内部调用 `ak.tool_trade_date_hist_sina()`，而该函数在 akshare 1.20.45 已更名为 `calendar_trade_date_hist_sina`，故该工具调用直接抛错（实测返回更名提示）。本项目不依赖该工具，改用行情数据本身的首末日期确定"最后有效交易日"。
3. **东方财富指数接口当前限频**。`ak.index_zh_hist_em(symbol="000001")` 实测抛 `Push2RateLimitError`（本机 IP 触发 push2 限频）。按指令不密集重试，改用新浪/腾讯备源。
4. **新浪/腾讯指数接口可用且完整**：
   - `ak.index_zh_daily_sina(symbol="sh000001")` → 8768 行，1990-12-19 ~ 2026-11-20，列 `[date, open, high, low, close, volume]`（未复权）。
   - `ak.index_zh_daily_tx(symbol="sh000001")` → 8758 行，列 `[date, open, close, high, low, volume, turnover, amount]`（**前复权**，比新浪少 10 行）。

### 2.3 输出与路径行为

- MCP 工具支持 `output_format` ∈ {json, csv, xml, excel, markdown, html}，但**单次返回整张 DataFrame**，无 `save_data` 到磁盘的能力（非官方 AKTools 的 `save_data`）。
- 本项目不通过 MCP 落盘，而是用 akshare 直接拉取 → `data/raw/*.csv`（原始）→ `data/processed/*.csv`（规范化）→ `data/processed/stats/*.json`（统计）。
- 未发现 1000 行硬上限；新浪指数接口一次返回全历史。

## 3. 实际成功调用记录（本机实测，非文档转述）

| 接口 | 参数 | 结果 | 首末日期 | 行数 | 单位 |
|------|------|------|----------|------|------|
| `index_zh_daily_sina` | sh000001 | OK | 1990-12-19 ~ 2026-11-20 | 8768 | 点位/股 |
| `index_zh_daily_sina` | sh000300 | OK | 2002-01-04 ~ 2026-11-20 | 6035 | 点位/股 |
| `index_zh_daily_sina` | sh000016 | OK | 2004-01-02 ~ 2026-11-20 | 5557 | 点位/股 |
| `index_zh_daily_sina` | sz399001 | OK | 1991-04-03 ~ 2026-11-20 | 8676 | 点位/股 |
| `index_zh_daily_sina` | sh000905 | OK | 2005-01-04 ~ 2026-11-20 | 5314 | 点位/股 |
| `index_zh_daily_sina` | sh000852 | OK | 2014-10-17 ~ 2026-11-20 | 2941 | 点位/股 |
| `index_zh_daily_sina` | sz399006 | OK | 2010-06-01 ~ 2026-11-20 | 4000 | 点位/股 |
| `index_zh_daily_tx` | sh000001 | OK | 1990-12-19 ~ 2026-11-20 | 8758 | 前复权/股/元 |
| `index_zh_hist_em` | 000001 | **限频** | Push2RateLimitError | — | — |

**采样验证**：上证指数 1990-12-19 开盘 96.05 / 收盘 99.98；2026-11-20 收盘 3533.793；历史最高**收盘** 6092.057（2007-10-16 盘中最高 6124.04，收盘 6092.06，二者口径不同，本页用收盘价）；2008 年熊市最低收盘 1706.70（2008-11-04）。与公开记录一致。

## 4. 数据质量核验结论

- 上证指数 8768 个交易日，日期严格递增、无重复、无缺失收盘价、`high ≥ max(open,close)`、`low ≤ min(open,close)` 全部通过（`tests/test_data_quality.py::test_real_index_quality`）。
- 早期（1990 年代初）存在制度性极端值：1992-05-21 单日 +105.27%（上海取消涨跌停限制），1995-05-23 单日 -16.39%。**均为真实事件，按指令保留，不删除尾部极端值**，但已在统计口径文档中注明早期制度差异，前端支持分时期筛选以隔离其影响。

## 5. 接口更名与版本注意事项（2026 年新版本）

- `tool_trade_date_hist_sina` → `calendar_trade_date_hist_sina`（1.20.45 起）。
- `stock_zh_a_hist` → `stock_zh_a_hist_em`（个股历史；本项目的指数数据不受此影响）。
- 指数历史正式接口以本机实测为准：`index_zh_daily_sina`（新浪）、`index_zh_daily_tx`（腾讯，前复权）、`index_zh_daily_em`/`index_zh_hist_em`（东方财富，可能限频）。
- 所有函数名均通过 `dir(akshare)` 与 `inspect.signature` 在本机实测，未盲用旧教程。
