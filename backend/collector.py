# -*- coding: utf-8 -*-
"""
数据采集器：调用数据源适配层抓取指数日线，规范化后落地 raw/ 与 processed/，
并增量写入 data/manifest.json。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Dict, List

# 保证能 import 项目根目录的 config
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
from backend.data_sources import fetch_index_daily  # noqa: E402
from backend.normalize import normalize_index, validate_ohlc  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def collect_one(index_key: str, meta: Dict) -> Dict:
    """抓取并落地单个指数。返回记录条目。

    数据不退化保护：若本次抓取行数明显少于已有 processed 数据（<95%），
    视为数据源降级/异常，保留旧数据并告警，不用短序列覆盖完整历史。
    """
    symbol = meta["symbol"]
    config.ensure_dirs()
    proc_path = os.path.join(config.PROCESSED_DIR, f"{index_key}.csv")

    old_rows = 0
    if os.path.exists(proc_path):
        try:
            old_rows = int(len(pd.read_csv(proc_path)))
        except Exception:  # noqa: BLE001
            old_rows = 0

    df_raw, source = fetch_index_daily(symbol)
    ndf = normalize_index(df_raw, source)
    issues = validate_ohlc(ndf)
    new_rows = int(len(ndf))

    if old_rows and new_rows < int(old_rows * 0.95):
        print(f"[KEEP] {meta['name']}({index_key}): 新抓取 {new_rows} 行 < 已有 {old_rows} 行，"
              f"判定数据源降级（{source}），保留旧数据不覆盖。")
        return {
            "key": index_key, "name": meta["name"], "market": meta.get("market", ""),
            "source_symbol": symbol, "source_interface": f"{source}(degraded, kept_old)",
            "rows": old_rows, "first_date": None, "last_date": None,
            "columns": list(ndf.columns), "quality_issues": issues + ["本次抓取行数偏少，已保留旧数据"],
            "downloaded_at": _now_iso(), "kept_old": True,
        }

    raw_path = os.path.join(config.RAW_DIR, f"{index_key}_{source}.csv")
    df_raw.to_csv(raw_path, index=False, encoding="utf-8-sig")
    ndf.to_csv(proc_path, index=False, encoding="utf-8-sig")

    first = str(ndf["date"].iloc[0]) if not ndf.empty else None
    last = str(ndf["date"].iloc[-1]) if not ndf.empty else None
    return {
        "key": index_key,
        "name": meta["name"],
        "market": meta.get("market", ""),
        "source_symbol": symbol,
        "source_interface": source,
        "rows": int(len(ndf)),
        "first_date": first,
        "last_date": last,
        "columns": list(ndf.columns),
        "quality_issues": issues,
        "downloaded_at": _now_iso(),
    }


def collect_all(indices: Dict[str, Dict]) -> List[Dict]:
    """抓取全部配置指数，单条失败不阻断其余。返回记录列表。"""
    config.ensure_dirs()
    records: List[Dict] = []
    errors: List[Dict] = []
    for key, meta in indices.items():
        try:
            rec = collect_one(key, meta)
            records.append(rec)
            print(f"[OK] {meta['name']}({key}): rows={rec['rows']} "
                  f"{rec['first_date']}~{rec['last_date']} via {rec['source_interface']}")
            if rec["quality_issues"]:
                print(f"     质量提示: {rec['quality_issues']}")
        except Exception as e:  # noqa: BLE001
            err = {"key": key, "name": meta["name"], "error": f"{type(e).__name__}: {e}"}
            errors.append(err)
            print(f"[FAIL] {meta['name']}({key}): {type(e).__name__}: {e}")
    manifest = {
        "project": "A股市场统计认知实验室",
        "version": 1,
        "generated_at": _now_iso(),
        "indices": records,
        "errors": errors,
    }
    mpath = os.path.join(config.PROCESSED_DIR, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\nmanifest -> {mpath}")
    return records


if __name__ == "__main__":
    collect_all(config.DEFAULT_INDICES)
