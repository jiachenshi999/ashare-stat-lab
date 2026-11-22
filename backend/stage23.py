# -*- coding: utf-8 -*-
"""阶段2/3 数据采集与统计（P1 市场广度/结构/流动性；P2 估值/行业）。

数据来源（均非东方财富，规避其限频）：
  - 腾讯 A 股实时快照 stock_zh_a_spot_tx：涨跌幅、总市值、流通市值、PE_TTM、PB
  - 中证指数公司 index_hist_csindex：指数成交额、滚动市盈率（官方）
  - 申万指数 index_first_info_sw（31 个一级行业 PE/PB/股息率）
  - 申万指数 index_hist_sw（行业指数历史日线）

产物（供前端静态读取）：
  frontend/data/market_snapshot.json
  frontend/data/liquidity.json
  frontend/data/valuation.json
  frontend/data/industry.json
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402

OUT = os.path.join(config.FRONTEND_DIR, "data")
TODAY = datetime.now(ZoneInfo("Asia/Shanghai"))


def _board_of(code: str) -> str:
    c = str(code).lower()
    if c.startswith("sh60"):
        return "沪市主板"
    if c.startswith("sh68"):
        return "科创板"
    if c.startswith("sz00"):
        return "深市主板"
    if c.startswith("sz30"):
        return "创业板"
    if c.startswith("bj"):
        return "北交所"
    return "其他"


def _num(s) -> float:
    try:
        return float(s)
    except Exception:  # noqa: BLE001
        return float("nan")


def build_market_snapshot() -> dict:
    """P1-5 广度 + P1-6 规模结构（仅最新截面）。"""
    import akshare as ak

    df = ak.stock_zh_a_spot_tx()
    df["board"] = df["code"].map(_board_of)
    for col in ["zdf", "zsz", "ltsz", "pe_ttm", "pn", "hsl", "zxj"]:
        if col in df.columns:
            df[col] = df[col].map(_num)
    # 过滤非正常报价（停牌/异常）
    df = df[df["zxj"].notna() & (df["zxj"] > 0)]
    df = df[df["zsz"].notna() & (df["zsz"] > 0)]

    ret = df["zdf"].dropna().to_numpy()
    n = int(ret.size)

    def stats(sub: pd.DataFrame) -> dict:
        r = sub["zdf"].dropna().to_numpy()
        return {
            "count": int(len(sub)),
            "up": int((r > 0).sum()),
            "down": int((r < 0).sum()),
            "flat": int((r == 0).sum()),
            "median_ret": float(np.median(r)) if r.size else None,
            "mean_ret": float(np.mean(r)) if r.size else None,
            "total_cap_yi": float(sub["zsz"].sum()),
            "float_cap_yi": float(sub["ltsz"].sum()),
        }

    boards = []
    for b in ["沪市主板", "深市主板", "创业板", "科创板", "北交所"]:
        sub = df[df["board"] == b]
        if len(sub):
            boards.append({"name": b, **stats(sub)})

    # 涨跌幅直方图
    bins = [-11, -7, -5, -3, -2, -1, 0, 1, 2, 3, 5, 7, 11]
    counts, _ = np.histogram(ret, bins=bins)

    # 市值分布（亿元）分桶
    caps = df["zsz"].to_numpy()
    cap_buckets = [
        {"label": "<20亿", "lo": 0, "hi": 20},
        {"label": "20~50亿", "lo": 20, "hi": 50},
        {"label": "50~100亿", "lo": 50, "hi": 100},
        {"label": "100~500亿", "lo": 100, "hi": 500},
        {"label": "500~1000亿", "lo": 500, "hi": 1000},
        {"label": ">=1000亿", "lo": 1000, "hi": float("inf")},
    ]
    cap_counts = [int(((caps >= b["lo"]) & (caps < b["hi"])).sum()) for b in cap_buckets]
    cap_sums = [float(caps[(caps >= b["lo"]) & (caps < b["hi"])].sum()) for b in cap_buckets]

    # 集中度：Top10/50/100 占总市值比例
    sorted_caps = np.sort(caps)[::-1]
    total_cap = float(sorted_caps.sum())
    top = {str(k): float(sorted_caps[:k].sum() / total_cap) if total_cap else None for k in (10, 50, 100)}

    # 洛伦兹曲线与基尼
    xs = np.sort(caps)
    cum = np.cumsum(xs) / total_cap
    m = min(200, xs.size)
    idx = np.linspace(0, xs.size - 1, m).astype(int)
    lorenz = [[float(idx[i] + 1) / xs.size, float(cum[idx[i]])] for i in range(m)]
    # 基尼系数
    nn = xs.size
    if nn > 1:
        sorted_x = np.sort(xs)
        cum_x = np.cumsum(sorted_x)
        gini = float((nn + 1 - 2 * (cum_x / cum_x[-1]).sum()) / nn)
    else:
        gini = None

    # 市值最大前 20 公司
    tops = df.sort_values("zsz", ascending=False).head(20)[["code", "name", "zsz", "ltsz", "zdf" if "zdf" in df.columns else "zsz"]]
    top_list = [{"code": r["code"], "name": r["name"], "cap_yi": float(r["zsz"]), "zdf": _num(r.get("zdf"))} for _, r in tops.iterrows()]

    # PE/PB 中位数（当前截面）
    pe = df["pe_ttm"].dropna().to_numpy()
    pe = pe[(pe > 0) & (pe < 500)]
    pb = df["pn"].dropna().to_numpy()
    pb = pb[(pb > 0) & (pb < 100)]

    return {
        "as_of": TODAY.strftime("%Y-%m-%d"),
        "source": "stock_zh_a_spot_tx（腾讯，最新截面）",
        "all": stats(df),
        "boards": boards,
        "hist": {"bins": bins, "counts": counts.tolist()},
        "cap_buckets": [{"label": b["label"], "count": cap_counts[i], "cap_yi": cap_sums[i]} for i, b in enumerate(cap_buckets)],
        "concentration": {"total_cap_yi": total_cap, "top_share": top, "gini": gini, "lorenz": lorenz},
        "top_companies": top_list,
        "pe_pb_median": {
            "pe_ttm_median": float(np.median(pe)) if pe.size else None,
            "pb_median": float(np.median(pb)) if pb.size else None,
            "pe_sample": int(pe.size), "pb_sample": int(pb.size),
        },
        "note": (
            "仅最新交易日截面，非历史序列。停牌、退市、ST、新股与北交所是否纳入会影响口径；"
            "市值以人民币总市值（含全部股种）计，与 A 股可流通部分不同。"
            "历史逐日广度需自行按日归档快照，本页不提供历史广度推断。"
        ),
    }


def build_liquidity_valuation() -> tuple[dict, dict]:
    """P1-7 指数成交额 + P2-8 指数滚动市盈率（中证指数公司官方源）。"""
    import akshare as ak

    codes = [("sh000001", "000001", "上证指数"), ("sh000300", "000300", "沪深300"),
             ("sh000016", "000016", "上证50"), ("sh000905", "000905", "中证500"),
             ("sh000852", "000852", "中证1000")]
    liq, val = [], []
    for key, code, name in codes:
        try:
            df = ak.index_hist_csindex(symbol=code, start_date="20040101", end_date=TODAY.strftime("%Y%m%d"))
        except Exception as e:  # noqa: BLE001
            print(f"[WARN] csindex {code} 失败: {e}")
            continue
        if df is None or df.empty:
            continue
        df = df.copy()
        df["日期"] = pd.to_datetime(df["日期"], errors="coerce")
        df = df.dropna(subset=["日期"]).sort_values("日期")
        # 成交额（亿元）与滚动市盈率
        dates = df["日期"].dt.strftime("%Y-%m-%d").tolist()
        amt = pd.to_numeric(df.get("成交金额"), errors="coerce")
        pe = pd.to_numeric(df.get("滚动市盈率"), errors="coerce")
        liq.append({"key": key, "name": name, "dates": dates, "amount_yi": [None if pd.isna(x) else round(float(x), 2) for x in amt]})
        val.append({"key": key, "name": name, "dates": dates, "pe_ttm": [None if pd.isna(x) else round(float(x), 3) for x in pe]})
    liquidity = {"indices": liq, "note": "中证指数公司官方口径的『指数成交金额』，是指数样本股成交额，不等于沪深全市场成交额。"}
    valuation = {"indices": val, "note": "滚动市盈率(PE_TTM)为指数样本口径；历史分位仅基于截至该日的已知数据计算。"}
    return liquidity, valuation


def build_industry() -> dict:
    """P2-9 申万一级行业：当前 PE/PB + 行业指数历史。"""
    import akshare as ak

    info = ak.index_first_info_sw()
    info = info.rename(columns={"行业代码": "code", "行业名称": "name", "成份个数": "n",
                                "TTM(滚动)市盈率": "pe_ttm", "市净率": "pb", "静态股息率": "div_yield"})
    industries = []
    for _, r in info.iterrows():
        raw_code = str(r["code"])
        code = raw_code.replace(".SI", "")  # index_hist_sw 需要 6 位代码
        item = {
            "code": raw_code, "name": r["name"], "n": int(r["n"]) if pd.notna(r["n"]) else None,
            "pe_ttm": _num(r.get("pe_ttm")), "pb": _num(r.get("pb")), "div_yield": _num(r.get("div_yield")),
            "dates": [], "close": [], "amount": [],
        }
        try:
            hist = ak.index_hist_sw(symbol=code, period="day")
            hist = hist.copy()
            hist["日期"] = pd.to_datetime(hist["日期"], errors="coerce")
            hist = hist.dropna(subset=["日期"]).sort_values("日期")
            item["dates"] = hist["日期"].dt.strftime("%Y-%m-%d").tolist()
            item["close"] = [round(float(x), 4) for x in pd.to_numeric(hist["收盘"], errors="coerce").fillna(0)]
            item["amount"] = [round(float(x), 4) if pd.notna(x) else None for x in pd.to_numeric(hist.get("成交额"), errors="coerce")]
        except Exception as e:  # noqa: BLE001
            print(f"[WARN] index_hist_sw {code} 失败: {e}")
        industries.append(item)
        print(f"[OK] 行业 {code} {r['name']} rows={len(item['dates'])}")
    return {"industries": industries, "note": "申万一级行业（31 个）当前估值与指数历史；行业分类以申万为准。"}


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    print("== 市场广度与结构 ==")
    try:
        snap = build_market_snapshot()
        with open(os.path.join(OUT, "market_snapshot.json"), "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False)
        print(f"[OK] market_snapshot.json  total={snap['all']['count']}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] market_snapshot: {e}")

    print("== 成交额与估值 ==")
    try:
        liq, val = build_liquidity_valuation()
        with open(os.path.join(OUT, "liquidity.json"), "w", encoding="utf-8") as f:
            json.dump(liq, f, ensure_ascii=False)
        with open(os.path.join(OUT, "valuation.json"), "w", encoding="utf-8") as f:
            json.dump(val, f, ensure_ascii=False)
        print(f"[OK] liquidity {len(liq['indices'])} / valuation {len(val['indices'])}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] liquidity/valuation: {e}")

    print("== 行业轮动 ==")
    try:
        ind = build_industry()
        with open(os.path.join(OUT, "industry.json"), "w", encoding="utf-8") as f:
            json.dump(ind, f, ensure_ascii=False)
        print(f"[OK] industry {len(ind['industries'])}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] industry: {e}")


if __name__ == "__main__":
    main()
