# -*- coding: utf-8 -*-
"""
数据源适配层：多来源指数历史行情（提高可用性）。

来源优先级（单来源失败自动降级，全部失败才报错）：
  1) 新浪  index_zh_daily_sina      —— 未复权，覆盖上证指数 1990 起全历史（主源）
  2) 中证指数公司 index_hist_csindex —— 官方源，覆盖 上证指数/沪深300/上证50/中证500/中证1000
  3) 腾讯  index_zh_daily_tx        —— 前复权，含成交额（末级备用）
东方财富 index_zh_hist_em 当前对本机 IP 限频，故不作为默认源。

所有来源均带重试上限 + 指数退避；不在此层做任何伪造/插值。
"""
from __future__ import annotations

from datetime import datetime
from typing import Callable, Optional, Tuple
from zoneinfo import ZoneInfo

import pandas as pd

MAX_RETRIES = 3
BASE_BACKOFF_SEC = 2.0

# 中证指数公司官方源可覆盖的指数代码（6 位）
CSINDEX_CODES = {"000001", "000300", "000016", "000905", "000852"}


def _retry_call(fn: Callable[[], pd.DataFrame], label: str) -> pd.DataFrame:
    """带指数退避的重试封装；全部失败则抛最后一次异常。"""
    import time

    last_err: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            df = fn()
            if df is not None and not df.empty:
                return df
            last_err = RuntimeError(f"{label} 返回空数据")
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(BASE_BACKOFF_SEC * (2 ** (attempt - 1)))
    raise last_err  # type: ignore[misc]


def fetch_index_sina(symbol: str) -> pd.DataFrame:
    """新浪指数日线。列: date/open/high/low/close/volume。"""
    import akshare as ak

    return ak.index_zh_daily_sina(symbol=symbol)


def fetch_index_csindex(code: str) -> pd.DataFrame:
    """中证指数公司官方日线。列: 日期/开盘/最高/最低/收盘/成交量/成交金额(亿元)。"""
    import akshare as ak

    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d")
    return ak.index_hist_csindex(symbol=code, start_date="19900101", end_date=today)


def fetch_index_tx(symbol: str) -> pd.DataFrame:
    """腾讯指数日线（前复权）。列: date/open/close/high/low/volume/turnover/amount。"""
    import akshare as ak

    return ak.index_zh_daily_tx(symbol=symbol)


def fetch_index_daily(symbol: str) -> Tuple[pd.DataFrame, str]:
    """
    获取指数日线，按 新浪 → 中证官方 → 腾讯 顺序回退。
    返回 (原始DataFrame, 来源标识)。来源标识用于 normalize 的列映射与单位换算。
    """
    code = symbol[-6:]
    errors = []

    # 1) 新浪（主源）
    try:
        df = _retry_call(lambda: fetch_index_sina(symbol), f"sina:{symbol}")
        return df, "index_zh_daily_sina"
    except Exception as e:  # noqa: BLE001
        errors.append(f"sina={type(e).__name__}:{e}")

    # 2) 中证指数公司官方（仅覆盖部分代码）
    if code in CSINDEX_CODES:
        try:
            df = _retry_call(lambda: fetch_index_csindex(code), f"csindex:{code}")
            return df, "index_hist_csindex"
        except Exception as e:  # noqa: BLE001
            errors.append(f"csindex={type(e).__name__}:{e}")

    # 3) 腾讯（末级备用）
    try:
        df = _retry_call(lambda: fetch_index_tx(symbol), f"tx:{symbol}")
        return df, "index_zh_daily_tx"
    except Exception as e:  # noqa: BLE001
        errors.append(f"tx={type(e).__name__}:{e}")

    raise RuntimeError(f"指数 {symbol} 所有数据源均失败: " + "; ".join(errors))
