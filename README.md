# A股市场统计认知实验室（A-Share Market Statistical Laboratory）

用真实历史数据与严谨、可交互的统计图，认识中国 A 股市场的波动、极端风险、回撤与长期持有结果。

> 本页面不构成任何投资建议；所有数字均为历史样本经验统计，不代表未来概率。

## 一、运行环境

- Windows 10/11，8GB 内存即可。
- 已安装 DeepSeek Harness + AkShare 系 MCP（`china-stock-mcp`，内含 akshare 1.20.65 + Python 3.12.14）。
- 无需安装 Node.js、无需付费 API Key；数据已本地缓存，断网可看。

## 二、快速开始

1. **首次/更新数据**（需要联网）：双击 `update_data.bat`，或运行
   ```bat
   update_data.bat
   ```
   该步骤抓取上证指数、沪深300、上证50、深证成指、中证500、中证1000、创业板指的**真实历史日线**，规范化后落地 `data/`，并计算全部统计量。

2. **启动网页**：双击 `start.bat`，或运行
   ```bat
   start.bat
   ```
   然后在浏览器打开 **http://127.0.0.1:8765**（仅本机）。

3. 停止：在启动窗口按 `Ctrl+C`。

> 若双击 `.bat` 无反应，可手动执行：
> ```bat
> cd /d 项目目录
> "C:\Users\Lenovo\.dsh\mcp-servers\china-stock-mcp\venv\Scripts\python.exe" app.py
> ```
> （若该解释器路径不存在，改用任意 Python 3.8+ 运行 `app.py`；数据更新还需 akshare。）

## 三、已实现功能（P0 核心，全部通过验收）

- **P0-1 每日涨跌幅的概率分布**：直方图（可调 bin 宽度 0.1/0.25/0.5/1.0）+ 核密度 + 正态参考；ECDF 与左尾；逐年箱线；单日极端涨跌 TOP20（点击定位）；按交易日查询历史百分位；阈值尾部频率（P(R≤x)/P(R≤-|x|)/P(|R|≥|x|)）。
- **P0-2 极端事件与尾部**：日收益时序散点（标注极端值）；绝对收益按年份分布；滚动 250 日年化波动率；左尾经验分布 vs 正态；历史 VaR/CVaR。
- **P0-3 牛熊、回撤与等待**：价格走势（对数轴切换）+ 历史峰值；回撤水下图；回撤事件深度-持续时长散点（未恢复事件右删失）；滚动 1/3 年最大回撤。
- **P0-4 持有期收益**：不同持有期（5/20/60/120/250/500 交易日）箱线、盈利/亏损比例、分布直方图与汇总表。
- 顶部筛选：研究对象（7 个指数）× 时间范围（全部/近1/3/5/10年/自定义）。
- 每个模块标注：研究对象、样本起止、有效样本量 N、统计定义、数据来源、更新时间，并含"主要发现"与"容易误读"注释。

## 四、目录结构

```
Ashare-Stat-Lab/
├─ start.bat / update_data.bat
├─ app.py                     # 本地服务入口（纯标准库，127.0.0.1:8765）
├─ config.py                  # 全局配置（指数清单、阈值、路径）
├─ update_data.py             # 数据更新入口（抓取→规范化→统计）
├─ backend/
│  ├─ data_sources.py         # akshare 指数接口适配（新浪主、腾讯备）
│  ├─ collector.py            # 采集 + 落盘 raw/processed + manifest
│  ├─ normalize.py            # 字段/单位规范化 + 质量校验
│  ├─ analytics.py            # 核心统计（收益/分位/尾部/回撤/持有期）
│  └─ compute.py              # 生成 stats/*.json
├─ frontend/                  # index.html + styles.css + app.js + 本地 echarts
├─ data/{raw,processed}/
├─ tests/                     # 单元测试 + JS 冒烟测试
└─ docs/                      # 审计/数据字典/统计方法/限制/实现报告
```

## 五、测试与验证

```bat
:: Python 单元测试（统计口径 + 数据质量）
"C:\...\china-stock-mcp\venv\Scripts\python.exe" -m unittest discover -s tests -v

:: 前端 JS 与后端交叉验证（需 DSH 自带 Node，或任意 Node）
node tests/smoke_js.js
```

## 六、常见问题

- **页面提示"无法加载数据"**：先运行 `update_data.bat` 生成 `data/processed/stats/*.json`。
- **某指数无数据**：检查 `data/processed/manifest.json` 中的 `errors` 字段（多为新浪/腾讯接口临时不可用）。
- **端口被占用**：修改 `config.py` 中的 `PORT`。
- **更新失败**：旧数据不受影响，页面继续显示上次缓存，并提示"未更新至最新"。

## 七、数据来源与免责

数据源：新浪财经指数日线（经 akshare 1.20.65 调用）。指数价格收益不含分红；早期市场制度差异导致极端值真实存在。详见 `docs/data_source_audit.md`、`docs/STATISTICAL_METHODS.md`、`docs/LIMITATIONS.md`。
