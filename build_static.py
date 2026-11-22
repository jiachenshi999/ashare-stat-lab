# -*- coding: utf-8 -*-
"""生成前端静态数据目录 frontend/data/。

使同一个前端既能在本地 Python 服务（app.py）运行，也能作为纯静态站点
托管到 GitHub Pages —— 二者都用相对路径 data/... 读取。

产物：
  frontend/data/indices.json       研究对象清单（含 has_stats）
  frontend/data/stats/{key}.json   各指数统计
  frontend/data/events.json        历史事件库
"""
from __future__ import annotations

import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402


def build_static() -> str:
    config.ensure_dirs()
    fd = os.path.join(config.FRONTEND_DIR, "data")
    stats_out = os.path.join(fd, "stats")
    os.makedirs(stats_out, exist_ok=True)

    manifest = {}
    mp = os.path.join(config.PROCESSED_DIR, "manifest.json")
    if os.path.exists(mp):
        try:
            with open(mp, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:  # noqa: BLE001
            manifest = {}
    man_idx = {r.get("key"): r for r in manifest.get("indices", [])}
    src_stats = os.path.join(config.PROCESSED_DIR, "stats")

    indices = {}
    for k, meta in config.DEFAULT_INDICES.items():
        entry = dict(meta)
        entry.update(man_idx.get(k, {}))
        src = os.path.join(src_stats, f"{k}.json")
        entry["has_stats"] = os.path.exists(src)
        indices[k] = entry
        if entry["has_stats"]:
            shutil.copyfile(src, os.path.join(stats_out, f"{k}.json"))

    with open(os.path.join(fd, "indices.json"), "w", encoding="utf-8") as f:
        json.dump(indices, f, ensure_ascii=False, indent=2)

    ev = os.path.join(config.PROJECT_ROOT, "data", "events.json")
    if os.path.exists(ev):
        shutil.copyfile(ev, os.path.join(fd, "events.json"))

    print(f"[static] 前端静态数据已生成 -> {fd}")
    return fd


if __name__ == "__main__":
    build_static()
