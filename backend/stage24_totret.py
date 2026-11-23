# -*- coding: utf-8 -*-
"""Stage 2.4：补充「分红全收益指数」数据。

数据源：中证指数公司官方接口（akshare index_hist_csindex）
标的：H00300 沪深300全收益指数（CSI 300 Total Return Index）
产出：frontend/data/total_return.json（供 P2-8「价格收益 vs 全收益」使用）
约定：原始数据同时落盘 data/raw/，便于复核；失败不覆盖已有产出。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime

import akshare as ak

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
FRONTEND_DATA = os.path.join(ROOT, "frontend", "data")

SYMBOL = "H00300"
NAME = "沪深300全收益"
NOTE = (
    "中证指数公司官方全收益指数（H00300），把样本股现金分红按除息日再投资计入，"
    "用于与沪深300价格指数（000300）对比，衡量分红对长期收益的贡献。"
)


def main() -> int:
    print(f"[stage24] 抓取 {SYMBOL} {NAME} ...")
    df = ak.index_hist_csindex(symbol=SYMBOL)
    if df is None or len(df) == 0:
        print("[stage24] 失败：接口返回空")
        return 1

    df = df.rename(columns={"日期": "date", "收盘": "close", "开盘": "open",
                            "最高": "high", "最低": "low", "成交额": "amount"})
    df = df[["date", "close", "open", "high", "low"]].dropna(subset=["close"])
    df["date"] = df["date"].astype(str)
    df = df.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)

    os.makedirs(RAW_DIR, exist_ok=True)
    raw_path = os.path.join(RAW_DIR, f"index_{SYMBOL}_csindex.csv")
    df.to_csv(raw_path, index=False, encoding="utf-8-sig")

    payload = {
        "key": SYMBOL,
        "name": NAME,
        "price_counterpart": "sh000300",
        "price_counterpart_name": "沪深300",
        "source_interface": "index_hist_csindex",
        "currency": "点",
        "first_date": df["date"].iloc[0],
        "last_date": df["date"].iloc[-1],
        "n": int(len(df)),
        "dates": df["date"].tolist(),
        "close": [round(float(x), 2) for x in df["close"].tolist()],
        "note": NOTE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    os.makedirs(FRONTEND_DATA, exist_ok=True)
    out_path = os.path.join(FRONTEND_DATA, "total_return.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(out_path) / 1024
    print(f"[stage24] OK  {payload['first_date']} ~ {payload['last_date']}  N={payload['n']}  {size_kb:.1f}KB -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
