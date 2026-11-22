# -*- coding: utf-8 -*-
"""
统计计算器：读取 data/processed/{key}.csv，计算全部 P0 统计量，
输出 data/processed/stats/{key}.json（由前端 API 直接读取）。
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
from backend import analytics as A  # noqa: E402

HORIZONS = [5, 20, 60, 120, 250, 500]
TAIL_THRESHOLDS = [1, 2, 3, 5]
UNDERWATER_THRESHOLDS = [5, 10, 20]


def _round_list(values, ndigits: int = 4):
    return [round(float(x), ndigits) for x in values]


def compute_index(key: str, meta: Dict) -> Dict:
    proc_path = os.path.join(config.PROCESSED_DIR, f"{key}.csv")
    df = pd.read_csv(proc_path)
    df = df.dropna(subset=["close"])
    close = df["close"].to_numpy(dtype=float)
    dates = df["date"].astype(str).tolist()
    n = int(close.size)

    ret = A.daily_returns_pct(close)
    ret_dates = dates[1:] if n > 1 else []

    # 回撤
    dd_series = A.drawdown_series(close)
    dd_events = A.drawdown_events(close, dates)
    mdd = A.max_drawdown(close)
    mdd_full = {
        "max_drawdown": mdd["max_dd"],
        "peak_date": dates[mdd["peak_idx"]] if mdd["peak_idx"] is not None else None,
        "trough_date": dates[mdd["trough_idx"]] if mdd["trough_idx"] is not None else None,
    }

    # 当前距历史高点回撤（最后一个交易日）
    last_close = float(close[-1]) if n else None
    hist_peak = float(np.max(close)) if n else None
    current_dd = (last_close / hist_peak - 1.0) if (n and hist_peak) else None

    payload = {
        "key": key,
        "name": meta["name"],
        "market": meta.get("market", ""),
        "source_interface": meta.get("source_interface", "unknown"),
        "first_date": dates[0] if n else None,
        "last_date": dates[-1] if n else None,
        "n": n,
        "n_returns": int(ret.size),
        "updated_at": meta.get("downloaded_at"),
        "dates": dates,
        "close": _round_list(close, 2),
        "returns_pct": _round_list(ret, 4),
        "returns_dates": ret_dates,
        "summary": A.summary_stats(ret),
        "tail_frequencies": A.tail_frequencies(ret, TAIL_THRESHOLDS),
        "extreme_events": A.extreme_events(ret, ret_dates, top_k=20),
        "yearly": {k: _round_list(v, 4) for k, v in A.yearly_returns_distribution(ret, ret_dates).items()},
        "drawdown_series": {
            "dd": _round_list(dd_series["dd"], 6),
            "cummax": _round_list(dd_series["cummax"], 2),
        },
        "drawdown_events": dd_events,
        "max_drawdown": mdd_full,
        "underwater_ratios": A.underwater_ratios(close, UNDERWATER_THRESHOLDS),
        "longest_streaks": A.longest_streaks(close, dates),
        "rolling_mdd_1y": A.rolling_max_drawdown(close, 252),
        "rolling_mdd_3y": A.rolling_max_drawdown(close, 756),
        "holding_returns": A.holding_returns(close, HORIZONS),
        "current": {
            "last_close": last_close,
            "hist_peak": hist_peak,
            "current_drawdown": current_dd,
            "last_return_pct": float(ret[-1]) if ret.size else None,
        },
    }
    return payload


def compute_all(indices: Dict[str, Dict]) -> List[Dict]:
    config.ensure_dirs()
    stats_dir = os.path.join(config.PROCESSED_DIR, "stats")
    os.makedirs(stats_dir, exist_ok=True)

    # 读取 manifest 以获取 source_interface / downloaded_at
    manifest_path = os.path.join(config.PROCESSED_DIR, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:  # noqa: BLE001
            manifest = {}
    man_indices = {r["key"]: r for r in manifest.get("indices", [])}

    results = []
    for key, meta in indices.items():
        merged = dict(meta)
        merged.update(man_indices.get(key, {}))
        try:
            payload = compute_index(key, merged)
            out_path = os.path.join(stats_dir, f"{key}.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            results.append({"key": key, "ok": True, "n": payload["n"], "n_returns": payload["n_returns"]})
            print(f"[OK] stats {key} ({payload['name']}): n={payload['n']} -> {out_path}")
        except Exception as e:  # noqa: BLE001
            results.append({"key": key, "ok": False, "error": f"{type(e).__name__}: {e}"})
            print(f"[FAIL] stats {key}: {type(e).__name__}: {e}")
    return results


if __name__ == "__main__":
    compute_all(config.DEFAULT_INDICES)
