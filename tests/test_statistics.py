# -*- coding: utf-8 -*-
"""
统计口径单元测试（用人工小数组验证公式，与《开发总指令》5.2 逐条对应）。
运行: python -m unittest tests.test_statistics -v   （或 pytest tests/）
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import analytics as A  # noqa: E402


class TestReturns(unittest.TestCase):
    def test_simple_returns(self):
        # 价格 [100,90,80,100,110] 手算收益
        close = np.array([100.0, 90.0, 80.0, 100.0, 110.0])
        r = A.daily_returns_pct(close)
        # r1=90/100-1=-10%, r2=80/90-1≈-11.111%, r3=100/80-1=25%, r4=110/100-1=10%
        expected = np.array([-10.0, (80 / 90 - 1) * 100, 25.0, 10.0])
        np.testing.assert_allclose(r, expected, rtol=1e-9)

    def test_first_record_dropped(self):
        close = np.array([100.0, 110.0])
        self.assertEqual(A.daily_returns_pct(close).size, 1)

    def test_log_returns(self):
        close = np.array([100.0, 110.0])
        self.assertAlmostEqual(A.log_returns_pct(close)[0], np.log(1.1) * 100, places=10)


class TestSummary(unittest.TestCase):
    def test_std_ddof1(self):
        # 已知样本标准差 ddof=1
        v = np.array([1.0, 2.0, 3.0, 4.0])
        self.assertAlmostEqual(A.sample_std(v), np.std(v, ddof=1), places=10)

    def test_annualized_vol(self):
        close = np.array([100.0, 101.0] * 2)  # 构造多日
        r = A.daily_returns_pct(close)
        s = A.summary_stats(r)
        expect = A.sample_std(r / 100.0) * np.sqrt(252) * 100.0
        self.assertAlmostEqual(s["annualized_vol_pct"], expect, places=8)

    def test_skewness_symmetric(self):
        v = np.array([-2.0, -1.0, 0.0, 1.0, 2.0])
        self.assertAlmostEqual(A.sample_skewness(v), 0.0, places=10)

    def test_excess_kurtosis_normal_like(self):
        # 正态近似，超额峰度接近 0
        rng = np.random.default_rng(0)
        v = rng.normal(0, 1, 100000)
        self.assertLess(abs(A.sample_excess_kurtosis(v)), 0.1)

    def test_quantiles(self):
        q = A.quantiles(np.array([1.0, 2.0, 3.0, 4.0]), [50])
        self.assertAlmostEqual(q["50"], 2.5, places=8)


class TestECDFTail(unittest.TestCase):
    def test_ecdf_counts(self):
        # 指令示例：[-3,-1,0,1,2] F(-1)=40%, P(R<=-2)=20%, P(|R|>=2)=40%
        r = np.array([-3.0, -1.0, 0.0, 1.0, 2.0])
        self.assertAlmostEqual(A.empirical_left_percentile(r, -1.0), 40.0, places=8)
        self.assertAlmostEqual(A.empirical_left_percentile(r, -2.0), 20.0, places=8)
        self.assertEqual(A.empirical_left_count(r, -1.0), 2)
        tf = A.tail_frequencies(r, [2.0])["2.0"]
        self.assertAlmostEqual(tf["p_abs_ge_pct"], 40.0, places=8)
        self.assertEqual(tf["count_abs_ge"], 2)

    def test_ecdf_inclusive(self):
        # 含相等值
        r = np.array([0.0, 0.0, 1.0])
        self.assertAlmostEqual(A.empirical_left_percentile(r, 0.0), 2 / 3 * 100, places=8)


class TestDrawdown(unittest.TestCase):
    def test_max_drawdown(self):
        # [100,90,80,100,110] 峰值到谷值 -20%
        close = np.array([100.0, 90.0, 80.0, 100.0, 110.0])
        mdd = A.max_drawdown(close)
        self.assertAlmostEqual(mdd["max_dd"], -0.20, places=9)
        self.assertEqual(mdd["peak_idx"], 0)
        self.assertEqual(mdd["trough_idx"], 2)

    def test_drawdown_event_recovery(self):
        close = np.array([100.0, 90.0, 80.0, 100.0, 110.0])
        dates = ["d0", "d1", "d2", "d3", "d4"]
        events = A.drawdown_events(close, dates)
        self.assertEqual(len(events), 1)
        e = events[0]
        self.assertEqual(e["peak_date"], "d0")
        self.assertEqual(e["trough_date"], "d2")
        self.assertEqual(e["recovery_date"], "d3")
        self.assertTrue(e["recovered"])
        self.assertAlmostEqual(e["max_drawdown"], -0.20, places=9)
        self.assertEqual(e["down_duration"], 2)
        self.assertEqual(e["recovery_duration"], 1)
        self.assertEqual(e["total_duration"], 3)

    def test_drawdown_censored(self):
        # 未恢复（右删失）
        close = np.array([100.0, 90.0, 80.0, 85.0])
        dates = ["d0", "d1", "d2", "d3"]
        events = A.drawdown_events(close, dates)
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0]["recovered"])
        self.assertIsNone(events[0]["recovery_date"])
        self.assertAlmostEqual(events[0]["max_drawdown"], -0.20, places=9)

    def test_new_high_then_recovery(self):
        close = np.array([100.0, 95.0, 110.0, 105.0, 120.0])
        dates = ["d0", "d1", "d2", "d3", "d4"]
        events = A.drawdown_events(close, dates)
        # 两个水下区间：d1(95) 和 d3(105)
        self.assertEqual(len(events), 2)
        self.assertTrue(all(e["recovered"] for e in events))


class TestHoldingReturns(unittest.TestCase):
    def test_holding_returns(self):
        # [100,110,121] h=1: R_0=10%, R_1=10%
        close = np.array([100.0, 110.0, 121.0])
        hr = A.holding_returns(close, [1])
        self.assertEqual(hr["1"]["n"], 2)
        self.assertAlmostEqual(hr["1"]["win_rate_pct"], 100.0, places=8)
        np.testing.assert_allclose(hr["1"]["returns_pct"], [10.0, 10.0], rtol=1e-6)

    def test_horizon_insufficient(self):
        close = np.array([100.0, 110.0, 121.0])
        hr = A.holding_returns(close, [10])
        self.assertEqual(hr["10"]["n"], 0)


class TestUnits(unittest.TestCase):
    def test_lots_shares(self):
        from backend.normalize import lots_to_shares, shares_to_lots
        self.assertEqual(lots_to_shares(1), 100.0)
        self.assertEqual(shares_to_lots(100), 1.0)

    def test_wan_yi(self):
        from backend.normalize import wan_to_yuan, yi_to_yuan, yuan_to_yi, yuan_to_wan
        self.assertEqual(wan_to_yuan(1), 1e4)
        self.assertEqual(yi_to_yuan(1), 1e8)
        self.assertEqual(yuan_to_yi(1e8), 1.0)
        self.assertEqual(yuan_to_wan(1e4), 1.0)


if __name__ == "__main__":
    unittest.main()
