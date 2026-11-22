# -*- coding: utf-8 -*-
"""
数据质量与规范化单元测试。
运行: python -m unittest tests.test_data_quality -v   （或 pytest tests/）
"""
from __future__ import annotations

import os
import sys
import unittest

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.normalize import normalize_index, validate_ohlc, STD_COLUMNS  # noqa: E402


def _good_df():
    return pd.DataFrame({
        "date": ["2020-01-02", "2020-01-03", "2020-01-06"],
        "open": [100.0, 101.0, 102.0],
        "high": [103.0, 104.0, 105.0],
        "low": [99.0, 100.0, 101.0],
        "close": [102.0, 103.0, 104.0],
        "volume": [1000, 2000, 3000],
    })


class TestValidateOHLC(unittest.TestCase):
    def test_good_data_no_issues(self):
        self.assertEqual(validate_ohlc(_good_df()), [])

    def test_high_below_close(self):
        df = _good_df()
        df.loc[0, "high"] = 90.0
        self.assertTrue(any("high" in i for i in validate_ohlc(df)))

    def test_low_above_open(self):
        df = _good_df()
        df.loc[1, "low"] = 200.0
        self.assertTrue(any("low" in i for i in validate_ohlc(df)))

    def test_non_positive_close(self):
        df = _good_df()
        df.loc[2, "close"] = 0.0
        self.assertTrue(any("<=0" in i for i in validate_ohlc(df)))

    def test_duplicate_dates(self):
        df = _good_df()
        df.loc[2, "date"] = "2020-01-02"
        self.assertTrue(any("重复" in i for i in validate_ohlc(df)))

    def test_unsorted_dates(self):
        df = _good_df().iloc[::-1].reset_index(drop=True)
        self.assertTrue(any("升序" in i for i in validate_ohlc(df)))


class TestNormalize(unittest.TestCase):
    def test_sina_mapping(self):
        df = pd.DataFrame({
            "date": ["2020-01-03", "2020-01-02"],
            "open": [101.0, 100.0],
            "high": [104.0, 103.0],
            "low": [100.0, 99.0],
            "close": [103.0, 102.0],
            "volume": [2000, 1000],
        })
        out = normalize_index(df, "index_zh_daily_sina")
        self.assertEqual(list(out.columns), STD_COLUMNS)
        # 升序
        self.assertEqual(out["date"].iloc[0], "2020-01-02")
        # amount 缺失补 NaN
        self.assertTrue(out["amount"].isna().all())

    def test_tx_mapping_has_amount(self):
        df = pd.DataFrame({
            "date": ["2020-01-02"],
            "open": [100.0],
            "close": [102.0],
            "high": [103.0],
            "low": [99.0],
            "volume": [1000],
            "turnover": [0.01],
            "amount": [5e8],
        })
        out = normalize_index(df, "index_zh_daily_tx")
        self.assertEqual(out["amount"].iloc[0], 5e8)
        self.assertEqual(out["close"].iloc[0], 102.0)


class TestRealDataQuality(unittest.TestCase):
    """对真实落地的上证指数数据做一次冒烟校验（若数据尚未生成则跳过）。"""

    def test_real_index_quality(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(root, "data", "processed", "sh000001.csv")
        if not os.path.exists(path):
            self.skipTest("sh000001.csv 尚未生成")
        df = pd.read_csv(path)
        self.assertGreater(len(df), 8000)  # 上证指数应有 >8000 个交易日
        issues = validate_ohlc(df)
        self.assertEqual(issues, [])


if __name__ == "__main__":
    unittest.main()
