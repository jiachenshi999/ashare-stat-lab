# -*- coding: utf-8 -*-
"""
数据更新入口：抓取最新交易日数据 → 规范化 → 重算统计。
用法: python update_data.py
（增量：仅补取最新缺失交易日；此处为全量重拉，简单可靠且数据量小。）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
from backend.collector import collect_all  # noqa: E402
from backend.compute import compute_all  # noqa: E402
from build_static import build_static  # noqa: E402


def main() -> None:
    print("=" * 60)
    print("A股市场统计认知实验室 - 数据更新")
    print("=" * 60)
    config.ensure_dirs()
    collect_all(config.DEFAULT_INDICES)
    print("\n" + "=" * 60)
    compute_all(config.DEFAULT_INDICES)
    print("\n" + "=" * 60)
    build_static()
    print("\n完成。启动服务请运行 python app.py")


if __name__ == "__main__":
    main()
