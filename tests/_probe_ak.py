# -*- coding: utf-8 -*-
"""探测：补齐 P2/P1 数据缺口所需的 AkShare 接口在当前网络与版本下是否可用。"""
import time
import traceback

import akshare as ak


def probe(name, fn):
    t0 = time.time()
    try:
        df = fn()
        dt = time.time() - t0
        cols = list(getattr(df, "columns", []))
        print(f"[OK] {name}  rows={len(df)}  {dt:.1f}s")
        print(f"     cols={cols[:14]}")
        if len(df):
            print(f"     head={df.head(2).to_dict('records')}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] {name}  {type(e).__name__}: {e}")
        traceback.print_exc(limit=1)
    print("-" * 70)


if __name__ == "__main__":
    probe("全收益指数 沪深300(H00300)", lambda: ak.index_hist_csindex(symbol="H00300"))
    probe("全A快照 stock_zh_a_spot_em", lambda: ak.stock_zh_a_spot_em())
    probe("申万一级行业 sw_index_first_info", lambda: ak.sw_index_first_info())
    probe("申万行业成分 index_component_sw(801010)", lambda: ak.index_component_sw(symbol="801010"))
