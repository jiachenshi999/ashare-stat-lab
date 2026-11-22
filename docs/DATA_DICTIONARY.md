# 数据字典（docs/DATA_DICTIONARY.md）

## 1. 目录结构

```
data/
├─ raw/                        原始抓取数据（未改动）
│  └─ {key}_{source}.csv       source ∈ {index_zh_daily_sina, index_zh_daily_tx}
├─ processed/
│  ├─ {key}.csv                规范化行情（统一列）
│  ├─ stats/{key}.json         已计算统计量（前端 API 数据源）
│  └─ manifest.json            采集清单（来源/参数/首末日期/行数/质量/时间）
```

## 2. 证券代码唯一标识（key）

采用带交易所前缀的唯一标识，避免 `000001` 上证指数与深市个股 `000001`（平安银行）混淆：

| key | 名称 | 数据源 symbol | 市场 |
|-----|------|---------------|------|
| sh000001 | 上证指数 | sh000001 | 上海证券交易所 |
| sh000300 | 沪深300 | sh000300 | 中证指数（跨市场） |
| sh000016 | 上证50 | sh000016 | 中证指数（上交所） |
| sz399001 | 深证成指 | sz399001 | 深圳证券交易所 |
| sh000905 | 中证500 | sh000905 | 中证指数（跨市场） |
| sh000852 | 中证1000 | sh000852 | 中证指数（跨市场） |
| sz399006 | 创业板指 | sz399006 | 深圳证券交易所 |

> 注：指数代码 ≠ 上市板块。上证综指 ≠ 沪市主板；沪深300 ≠ 沪深主板。某图写"沪深300历史收益"就只能写"沪深300"，不可写成"主板整体收益"。

## 3. 规范化行情字段（data/processed/{key}.csv）

| 字段 | 含义 | 单位 | 说明 |
|------|------|------|------|
| date | 交易日 | YYYY-MM-DD（Asia/Shanghai） | 升序，无重复 |
| open | 开盘 | 指数点位 | |
| high | 最高 | 指数点位 | |
| low | 最低 | 指数点位 | |
| close | 收盘 | 指数点位 | 本项目的价格收益/回撤/持有期均基于收盘价 |
| volume | 成交量 | 股 | 新浪源为成交股数 |
| amount | 成交额 | 元 | 仅腾讯源提供；新浪源为 NaN |

## 4. 统计量字段（data/processed/stats/{key}.json）

| 顶层键 | 含义 |
|--------|------|
| key / name / market / source_interface | 标识与来源 |
| first_date / last_date / n / n_returns | 首末日期、价格样本 N、收益样本 N-1 |
| updated_at | 数据下载时间 |
| dates / close / returns_pct / returns_dates | 全量序列（前端交互重算的原料） |
| summary | 描述统计（见 STATISTICAL_METHODS） |
| tail_frequencies | 阈值 a=1/2/3/5 的 P(R≤-a)、P(R≥a)、P(|R|≥a) |
| extreme_events | 单日涨/跌 TOP20（date, ret_pct） |
| yearly | 按年分组的日收益（箱线图数据） |
| drawdown_series | dd 与 cummax 序列 |
| drawdown_events | 每次水下事件（含右删失标记） |
| max_drawdown | 全样本最大回撤 + 峰值日/谷底日 |
| underwater_ratios | DD≤-5%/-10%/-20% 的交易日占比 |
| longest_streaks | 最长连续未创新高区间 |
| rolling_mdd_1y / rolling_mdd_3y | 滚动 252/756 交易日最大回撤 |
| holding_returns | 持有期 5/20/60/120/250/500 的收益汇总 |
| current | 最新收盘、历史峰值、当前回撤、最新日收益 |

## 5. 单位与转换（含自动测试）

- 手 ↔ 股：×100；万元 ↔ 元：×10^4；亿元 ↔ 元：×10^8。
- 收益：计算用小数，展示用 %（×100）。年化波动率用小数收益，最终展示 %。
- 均已写入 `backend/normalize.py` 并由 `tests/test_statistics.py::TestUnits` 验证。
