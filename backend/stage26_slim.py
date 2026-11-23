# -*- coding: utf-8 -*-
"""Stage 2.6：前端数据瘦身（indstry.json / valuation.json）。

背景：industry.json 约 4.4MB，是 P2 页面首屏加载慢与"空图窗口"的物理原因。
做法：只改**前端副本**，不动统计口径——
  1) 删除前端从未使用的 `amount` 数组（31 行业 × 约 6500 日，约 1.2MB）；
  2) 价格、PE、PB、股息率统一保留 2 位小数（原数据精度 ≤ 4 位，四舍五入误差 < 0.005）；
  3) valuation.json 的 PE 保留 2 位小数，null 原样保留（保持日期对齐）。
先在 data/backup/ 留全量备份，失败不覆盖。
"""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "frontend", "data")
BACKUP = os.path.join(ROOT, "data", "backup")


def kb(path: str) -> float:
    return os.path.getsize(path) / 1024


def backup(path: str) -> str:
    os.makedirs(BACKUP, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = os.path.join(BACKUP, f"{os.path.splitext(os.path.basename(path))[0]}_full_{stamp}.json")
    shutil.copy2(path, dst)
    return dst


def r2(x):
    return None if x is None else round(float(x), 2)


def slim_industry() -> None:
    path = os.path.join(DATA, "industry.json")
    before = kb(path)
    src = backup(path)
    with open(path, "r", encoding="utf-8") as f:
        j = json.load(f)
    dropped = 0
    for ind in j.get("industries", []):
        if "amount" in ind:
            dropped += len(ind["amount"])
            ind.pop("amount", None)
        for k in ("close", "pe_ttm", "pb", "div_yield"):
            if k in ind and isinstance(ind[k], list):
                ind[k] = [r2(v) for v in ind[k]]
            elif k in ind:
                ind[k] = r2(ind[k])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(j, f, ensure_ascii=False, separators=(",", ":"))
    after = kb(path)
    print(f"[slim] industry.json {before:.2f}KB -> {after:.2f}KB "
          f"(-{100 * (1 - after / before):.1f}%)，移除 amount 点数={dropped}")
    print(f"[slim] 全量备份 -> {src}")


def slim_valuation() -> None:
    path = os.path.join(DATA, "valuation.json")
    before = kb(path)
    backup(path)
    with open(path, "r", encoding="utf-8") as f:
        j = json.load(f)
    for it in j.get("indices", []):
        if isinstance(it.get("pe_ttm"), list):
            it["pe_ttm"] = [r2(v) for v in it["pe_ttm"]]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(j, f, ensure_ascii=False, separators=(",", ":"))
    after = kb(path)
    print(f"[slim] valuation.json {before:.2f}KB -> {after:.2f}KB (-{100 * (1 - after / before):.1f}%)")


if __name__ == "__main__":
    slim_industry()
    slim_valuation()
