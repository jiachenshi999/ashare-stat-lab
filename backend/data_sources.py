# -*- coding: utf-8 -*-
"""
数据源适配层：通过本机已安装的 akshare（1.20.65）直接调用指数历史行情接口。

设计要点：
- 优先使用新浪 `index_zh_daily_sina`（未复权，覆盖上证指数自 1990-12-19 起全历史）；
- 新浪不可用时回退到腾讯 `index_zh_daily_tx`（前复权，指数价格序列差异极小，但仍单列来源记录）；
- 东方财富 `index_zh_hist_em` 当前对本机 IP 限频（Push2RateLimitError），按指令避免密集重试；
- 所有请求带重试上限 + 指数退避；不在此层做任何伪造/插值。
"""
from __future__ import annotations

import time
from typing import Callable, Optional, Tuple

import pandas as pd

# 重试配置
MAX_RETRIES = 3
BASE_BACKOFF_SEC = 2.0


def _retry_call(fn: Callable[[], pd.DataFrame], label: str) -> pd.DataFrame:
    """带指数退避的重试封装；全部失败则抛最后一次异常。"""
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
                sleep_s = BASE_BACKOFF_SEC * (2 ** (attempt - 1))
                time.sleep(sleep_s)
    raise last_err  # type: ignore[misc]


def fetch_index_sina(symbol: str) -> pd.DataFrame:
    """新浪指数日线。返回列: date/open/high/low/close/volume。"""
    import akshare as ak

    return ak.index_zh_daily_sina(symbol=symbol)


def fetch_index_tx(symbol: str) -> pd.DataFrame:
    """腾讯指数日线（前复权）。返回列: date/open/close/high/low/volume/turnover/amount。"""
    import akshare as ak

    return ak.index_zh_daily_tx(symbol=symbol)


def fetch_index_daily(symbol: str) -> Tuple[pd.DataFrame, str]:
    """
    获取指数日线，优先新浪、回退腾讯。
    返回 (原始DataFrame, 来源标识字符串)。
    """
    try:
        df = _retry_call(lambda: fetch_index_sina(symbol), f"sina:{symbol}")
        return df, "index_zh_daily_sina"
    except Exception as sina_err:  # noqa: BLE001
        try:
            df = _retry_call(lambda: fetch_index_tx(symbol), f"tx:{symbol}")
            return df, "index_zh_daily_tx"
        except Exception as tx_err:  # noqa: BLE001
            raise RuntimeError(
                f"指数 {symbol} 新浪与腾讯数据源均失败。"
                f"sina={type(sina_err).__name__}:{sina_err}; "
                f"tx={type(tx_err).__name__}:{tx_err}"
            ) from tx_err
