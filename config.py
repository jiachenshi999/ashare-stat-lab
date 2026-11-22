# -*- coding: utf-8 -*-
"""
A股市场统计认知实验室 —— 全局配置
纯标准库实现，不依赖第三方包，便于在任意 Python 3.8+ 解释器下运行。
"""
from __future__ import annotations

import os
import sys

# 项目根目录 = 本文件所在目录
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# 目录
RAW_DIR = os.path.join(PROJECT_ROOT, "data", "raw")
PROCESSED_DIR = os.path.join(PROJECT_ROOT, "data", "processed")
DOCS_DIR = os.path.join(PROJECT_ROOT, "docs")
LOGS_DIR = os.path.join(PROJECT_ROOT, "logs")
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

# 服务配置
HOST = "127.0.0.1"
PORT = 8765

# 交易日年化约定（252 交易日 ≈ 1 年）
TRADING_DAYS_PER_YEAR = 252

# 样本量阈值（低于阈值时前端需标注"样本不足"）
MIN_N_OVERALL = 100       # 总体分布稳定展示下限
MIN_N_ROLLING = 250       # 滚动指标稳定展示下限
MIN_N_EVENT = 30          # 极端条件事件稳定展示下限

# 默认研究指数（证券代码带交易所前缀，避免 000001 上证指数与深市个股混淆）
# key: 内部唯一标识   value: (名称, 数据源symbol)
DEFAULT_INDICES = {
    "sh000001": {"name": "上证指数", "symbol": "sh000001", "market": "上海证券交易所"},
    "sh000300": {"name": "沪深300", "symbol": "sh000300", "market": "中证指数(跨市场)"},
    "sh000016": {"name": "上证50", "symbol": "sh000016", "market": "中证指数(上交所)"},
    "sz399001": {"name": "深证成指", "symbol": "sz399001", "market": "深圳证券交易所"},
    "sh000905": {"name": "中证500", "symbol": "sh000905", "market": "中证指数(跨市场)"},
    "sh000852": {"name": "中证1000", "symbol": "sh000852", "market": "中证指数(跨市场)"},
    "sz399006": {"name": "创业板指", "symbol": "sz399006", "market": "深圳证券交易所"},
}


def ensure_dirs() -> None:
    """确保所有数据/日志/文档目录存在。"""
    for d in (RAW_DIR, PROCESSED_DIR, DOCS_DIR, LOGS_DIR, FRONTEND_DIR):
        os.makedirs(d, exist_ok=True)


def py_executable() -> str:
    """返回当前解释器路径（用于脚本内子进程调用，多数情况直接用 sys.executable）。"""
    return sys.executable
