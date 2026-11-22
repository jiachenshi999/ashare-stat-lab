# -*- coding: utf-8 -*-
"""
数据规范化与单位转换。
统一字段与单位，保证后续统计口径一致：
- date: 交易所本地日期 YYYY-MM-DD，时间升序（Asia/Shanghai）
- open/high/low/close: 指数点位（元/点）
- volume: 股（shares）
- amount: 元（yuan）；新浪源无成交额时为 NaN
"""
from __future__ import annotations

from typing import Dict, List, Tuple

import pandas as pd

# 统一列
STD_COLUMNS = ["date", "open", "high", "low", "close", "volume", "amount"]

# 各数据源列映射到统一列
_SOURCE_MAP = {
    "index_zh_daily_sina": {
        "date": "date",
        "open": "open",
        "high": "high",
        "low": "low",
        "close": "close",
        "volume": "volume",
    },
    "index_zh_daily_tx": {
        "date": "date",
        "open": "open",
        "high": "high",
        "low": "low",
        "close": "close",
        "volume": "volume",
        "amount": "amount",
    },
}


def normalize_index(df: pd.DataFrame, source: str) -> pd.DataFrame:
    """将原始指数行情标准化为统一列，并做基本类型/顺序处理。"""
    if df is None or df.empty:
        return pd.DataFrame(columns=STD_COLUMNS)

    mapping = _SOURCE_MAP.get(source)
    if mapping is None:
        raise ValueError(f"未知数据源: {source}")

    out = df.copy()
    # 统一列名
    rename = {v: k for k, v in mapping.items()}
    out = out.rename(columns=rename)

    # 确保存在所有统一列，缺失补 NaN
    for col in STD_COLUMNS:
        if col not in out.columns:
            out[col] = float("nan")

    out = out[STD_COLUMNS].copy()

    # 数值化
    for col in ["open", "high", "low", "close", "volume", "amount"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")

    # 日期标准化并升序
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out = out.dropna(subset=["date"])
    out["date"] = out["date"].dt.strftime("%Y-%m-%d")
    out = out.sort_values("date").reset_index(drop=True)

    return out


# ---------- 单位转换辅助（供 P1 流动性模块复用，附自动测试） ----------

def lots_to_shares(lots) -> float:
    """手 -> 股（1 手 = 100 股）。"""
    return float(lots) * 100.0


def shares_to_lots(shares) -> float:
    """股 -> 手。"""
    return float(shares) / 100.0


def wan_to_yuan(wan) -> float:
    """万元 -> 元。"""
    return float(wan) * 1e4


def yuan_to_wan(yuan) -> float:
    """元 -> 万元。"""
    return float(yuan) / 1e4


def yi_to_yuan(yi) -> float:
    """亿元 -> 元。"""
    return float(yi) * 1e8


def yuan_to_yi(yuan) -> float:
    """元 -> 亿元。"""
    return float(yuan) / 1e8


def validate_ohlc(df: pd.DataFrame) -> List[str]:
    """返回数据质量问题清单（空列表表示通过）。"""
    issues: List[str] = []
    if df.empty:
        return ["空数据"]

    d = pd.to_datetime(df["date"])
    # 单调递增
    if not d.is_monotonic_increasing:
        issues.append("日期未按时间升序")
    # 重复日期
    if d.duplicated().any():
        dup_n = int(d.duplicated().sum())
        issues.append(f"存在 {dup_n} 个重复日期")
    # 日期非法
    if d.isna().any():
        issues.append("存在非法/缺失日期")

    close = df["close"]
    if (close <= 0).any():
        issues.append("存在 <=0 的收盘价")
    if close.isna().any():
        issues.append("存在缺失收盘价")

    # OHLC 关系校验
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    valid = o.notna() & h.notna() & l.notna() & c.notna()
    if valid.any():
        sub = df[valid]
        if (sub["high"] < sub[["open", "close"]].max(axis=1)).any():
            issues.append("存在 high < max(open,close) 的记录")
        if (sub["low"] > sub[["open", "close"]].min(axis=1)).any():
            issues.append("存在 low > min(open,close) 的记录")

    return issues
