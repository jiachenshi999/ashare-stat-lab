# -*- coding: utf-8 -*-
"""
核心统计计算模块（P0-1 ~ P0-4）。

所有函数以 numpy 数组为输入、输出纯数据（dict / ndarray），便于单元测试。
口径严格遵循《开发总指令》：
- 日简单收益 r_t = (Close_t/Close_{t-1} - 1) * 100，单位 %
- 年化波动率 = std(小数日收益, ddof=1) * sqrt(252)
- 经验左侧百分位 F_n(x) = #{r_i <= x} / N（含相等值）
- 负向尾部频率 #{r_i <= -a}/N；双向大幅波动 #{|r_i| >= a}/N
- 回撤 DD_t = Close_t / cummax(Close_{<=t}) - 1
- 长持收益 R_(t,h) = Close_{t+h}/Close_t - 1
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np

TRADING_DAYS = 252


# --------------------------------------------------------------------------- #
# 基础收益
# --------------------------------------------------------------------------- #
def daily_returns_pct(close: np.ndarray) -> np.ndarray:
    """日简单收益率（%）。第一笔无前值不计入。"""
    close = np.asarray(close, dtype=float)
    if close.size < 2:
        return np.array([], dtype=float)
    return (close[1:] / close[:-1] - 1.0) * 100.0


def daily_returns_decimal(close: np.ndarray) -> np.ndarray:
    """日简单收益率（小数）。"""
    return daily_returns_pct(close) / 100.0


def log_returns_pct(close: np.ndarray) -> np.ndarray:
    """对数收益率（%），可选高级口径，默认不启用。"""
    close = np.asarray(close, dtype=float)
    if close.size < 2:
        return np.array([], dtype=float)
    return np.log(close[1:] / close[:-1]) * 100.0


# --------------------------------------------------------------------------- #
# 描述性统计
# --------------------------------------------------------------------------- #
def sample_std(values: np.ndarray) -> float:
    """样本标准差 ddof=1。"""
    v = np.asarray(values, dtype=float)
    if v.size < 2:
        return float("nan")
    return float(np.std(v, ddof=1))


def sample_skewness(values: np.ndarray) -> float:
    """Fisher-Pearson 偏度（偏置校正），与 scipy.stats.skew(bias=False) 一致。"""
    v = np.asarray(values, dtype=float)
    n = v.size
    if n < 3:
        return float("nan")
    m = v - v.mean()
    m2 = np.mean(m ** 2)
    m3 = np.mean(m ** 3)
    if m2 <= 0:
        return float("nan")
    g1 = m3 / (m2 ** 1.5)
    return float(np.sqrt(n * (n - 1)) / (n - 2) * g1)


def sample_excess_kurtosis(values: np.ndarray) -> float:
    """超额峰度（偏置校正），与 scipy.stats.kurtosis(bias=False) 一致。"""
    v = np.asarray(values, dtype=float)
    n = v.size
    if n < 4:
        return float("nan")
    m = v - v.mean()
    m2 = np.mean(m ** 2)
    m4 = np.mean(m ** 4)
    if m2 <= 0:
        return float("nan")
    g2 = m4 / (m2 ** 2) - 3.0
    return float(((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6.0))


def quantiles(values: np.ndarray, ps: Sequence[float]) -> Dict[str, float]:
    """线性插值分位数。返回 {q: value}。"""
    v = np.asarray(values, dtype=float)
    out: Dict[str, float] = {}
    for p in ps:
        out[f"{p:g}"] = float(np.percentile(v, p))
    return out


def summary_stats(returns_pct: np.ndarray) -> Dict:
    """P0-1 汇总统计。returns_pct 单位为 %。"""
    r = np.asarray(returns_pct, dtype=float)
    n = int(r.size)
    if n == 0:
        return {"n": 0}

    r_dec = r / 100.0
    pos = float(np.mean(r > 0))
    neg = float(np.mean(r < 0))
    zero = float(np.mean(r == 0))
    q = quantiles(r, [1, 5, 25, 50, 75, 95, 99])

    return {
        "n": n,
        "mean_pct": float(np.mean(r)),
        "median_pct": float(np.median(r)),
        "std_pct": sample_std(r),
        "annualized_vol_pct": sample_std(r_dec) * np.sqrt(TRADING_DAYS) * 100.0,
        "positive_days_pct": pos * 100.0,
        "negative_days_pct": neg * 100.0,
        "zero_days_pct": zero * 100.0,
        "min_pct": float(np.min(r)),
        "max_pct": float(np.max(r)),
        "skewness": sample_skewness(r),
        "excess_kurtosis": sample_excess_kurtosis(r),
        "p1": q["1"],
        "p5": q["5"],
        "p25": q["25"],
        "p50": q["50"],
        "p75": q["75"],
        "p95": q["95"],
        "p99": q["99"],
    }


# --------------------------------------------------------------------------- #
# ECDF 与尾部频率
# --------------------------------------------------------------------------- #
def ecdf(values: np.ndarray) -> Dict:
    """经验累积分布。返回排序后的 (x, F)。F(x)=#{r<=x}/N。"""
    v = np.asarray(values, dtype=float)
    n = v.size
    if n == 0:
        return {"x": [], "y": [], "n": 0}
    xs = np.sort(v)
    # 左侧累计概率（含相等值），步进阶梯
    y = (np.arange(1, n + 1)) / n
    return {"x": xs.tolist(), "y": y.tolist(), "n": n}


def empirical_left_percentile(values: np.ndarray, x: float) -> float:
    """F_n(x) = #{r_i <= x}/N，返回百分数 0~100（含相等值）。"""
    v = np.asarray(values, dtype=float)
    if v.size == 0:
        return float("nan")
    return float(np.mean(v <= x) * 100.0)


def empirical_left_count(values: np.ndarray, x: float) -> int:
    """#{r_i <= x}。"""
    v = np.asarray(values, dtype=float)
    return int(np.sum(v <= x))


def tail_frequencies(returns_pct: np.ndarray, thresholds: Sequence[float]) -> Dict:
    """
    对称尾部事件实际频率。
    对每个阈值 a>=0，返回：
      p_le_neg = P(R <= -a)
      p_ge_pos = P(R >= +a)
      p_abs_ge = P(|R| >= a)
    均以百分数返回。
    """
    r = np.asarray(returns_pct, dtype=float)
    n = r.size
    out: Dict = {}
    for a in thresholds:
        a_num = float(a)
        key = str(a)  # 保留原始类型（int 1 -> "1"）
        out[key] = {
            "threshold": a_num,
            "p_le_neg_pct": float(np.mean(r <= -a_num) * 100.0),
            "p_ge_pos_pct": float(np.mean(r >= a_num) * 100.0),
            "p_abs_ge_pct": float(np.mean(np.abs(r) >= a_num) * 100.0),
            "count_le_neg": int(np.sum(r <= -a_num)),
            "count_ge_pos": int(np.sum(r >= a_num)),
            "count_abs_ge": int(np.sum(np.abs(r) >= a_num)),
            "n": n,
        }
    return out


# --------------------------------------------------------------------------- #
# 直方图与核密度
# --------------------------------------------------------------------------- #
def histogram(returns_pct: np.ndarray, bin_width: float, lo: Optional[float] = None,
              hi: Optional[float] = None) -> Dict:
    """
    等宽直方图（概率密度口径：柱面积之和=1）。
    返回 bins(边界列表), density(每个 bin 的概率密度), counts(频数)。
    """
    r = np.asarray(returns_pct, dtype=float)
    if r.size == 0:
        return {"bins": [], "density": [], "counts": [], "bin_width": bin_width, "n": 0}
    lo = float(np.min(r)) if lo is None else float(lo)
    hi = float(np.max(r)) if hi is None else float(hi)
    if bin_width <= 0 or hi <= lo:
        return {"bins": [], "density": [], "counts": [], "bin_width": bin_width, "n": int(r.size)}
    # 使边界对齐到 bin_width 的整数倍，覆盖 [lo, hi]
    nbins = int(np.ceil((hi - lo) / bin_width))
    hi = lo + nbins * bin_width
    edges = lo + np.arange(nbins + 1) * bin_width
    counts, _ = np.histogram(r, bins=edges)
    density = counts / (r.size * bin_width)  # 概率密度
    return {
        "bins": edges.tolist(),
        "centers": ((edges[:-1] + edges[1:]) / 2).tolist(),
        "density": density.tolist(),
        "counts": counts.tolist(),
        "bin_width": bin_width,
        "n": int(r.size),
    }


def kde_gaussian(values: np.ndarray, n_points: int = 512, bandwidth: Optional[float] = None,
                 lo: Optional[float] = None, hi: Optional[float] = None) -> Dict:
    """高斯核密度估计（Silverman 带宽）。返回 (x, density)。"""
    v = np.asarray(values, dtype=float)
    n = v.size
    if n == 0:
        return {"x": [], "y": [], "n": 0, "bandwidth": 0.0}
    if bandwidth is None:
        std = np.std(v, ddof=1)
        if not np.isfinite(std) or std == 0:
            std = np.std(v)
        if std == 0:
            std = 1e-9
        # Silverman's rule of thumb
        bandwidth = 1.06 * std * n ** (-1.0 / 5.0)
    lo = float(np.min(v)) - 3.0 * bandwidth if lo is None else float(lo)
    hi = float(np.max(v)) + 3.0 * bandwidth if hi is None else float(hi)
    x = np.linspace(lo, hi, n_points)
    # 归一化高斯核
    diff = (x[:, None] - v[None, :]) / bandwidth
    dens = np.exp(-0.5 * diff ** 2).sum(axis=1)
    dens = dens / (n * bandwidth * np.sqrt(2.0 * np.pi))
    return {"x": x.tolist(), "y": dens.tolist(), "n": n, "bandwidth": float(bandwidth)}


def normal_pdf(x: np.ndarray, mean: float, std: float) -> np.ndarray:
    """正态参考概率密度。"""
    x = np.asarray(x, dtype=float)
    std = float(std)
    if std <= 0:
        return np.zeros_like(x)
    return np.exp(-0.5 * ((x - mean) / std) ** 2) / (std * np.sqrt(2.0 * np.pi))


# --------------------------------------------------------------------------- #
# 极端事件
# --------------------------------------------------------------------------- #
def extreme_events(returns_pct: np.ndarray, dates: Sequence[str], top_k: int = 20) -> Dict:
    """单日极端涨跌 TOP 事件。返回 up/down 两列表。"""
    r = np.asarray(returns_pct, dtype=float)
    n = r.size
    if n == 0:
        return {"up": [], "down": []}

    def top(ascending: bool):
        idx = np.argsort(r)
        if not ascending:
            idx = idx[::-1]
        out = []
        for j in idx[: min(top_k, n)]:
            out.append({
                "date": str(dates[j]),
                "ret_pct": float(r[j]),
            })
        return out

    return {"up": top(False), "down": top(True)}


def yearly_returns_distribution(returns_pct: np.ndarray, dates: Sequence[str]) -> Dict:
    """逐年日收益分布（用于箱线/小提琴图）。返回 {year: [returns...]}。"""
    r = np.asarray(returns_pct, dtype=float)
    years: Dict[str, List[float]] = {}
    for i in range(r.size):
        y = str(dates[i])[:4]
        years.setdefault(y, []).append(float(r[i]))
    # 按年份升序
    out = {k: years[k] for k in sorted(years.keys())}
    return out


# --------------------------------------------------------------------------- #
# 回撤
# --------------------------------------------------------------------------- #
def drawdown_series(close: np.ndarray) -> Dict:
    """DD_t = Close_t / cummax(Close_{<=t}) - 1。"""
    c = np.asarray(close, dtype=float)
    if c.size == 0:
        return {"dd": [], "cummax": [], "n": 0}
    cm = np.maximum.accumulate(c)
    dd = c / cm - 1.0
    return {"dd": dd.tolist(), "cummax": cm.tolist(), "n": int(c.size)}


def drawdown_events(close: np.ndarray, dates: Sequence[str]) -> List[Dict]:
    """
    每次回撤事件（最大水下区间）。
    事件字段：peak_date/value、trough_date/value、recovery_date、max_drawdown、
    down_duration、recovery_duration、total_duration、recovered。
    未恢复事件 recovery_* 为 null（右删失）。
    """
    c = np.asarray(close, dtype=float)
    n = c.size
    if n == 0:
        return []
    cm = np.maximum.accumulate(c)
    dd = c / cm - 1.0
    events: List[Dict] = []
    i = 0
    eps = 1e-12
    while i < n:
        if dd[i] >= -eps:
            i += 1
            continue
        # 水下区间起点 i（dd[i]<0），峰值日为 i-1（dd[i-1]==0）
        peak_idx = i - 1
        peak_val = c[peak_idx]
        peak_date = str(dates[peak_idx])
        trough_idx = i
        k = i
        while k < n and dd[k] < -eps:
            if c[k] < c[trough_idx]:
                trough_idx = k
            k += 1
        trough_val = c[trough_idx]
        max_dd = float(dd[trough_idx])
        if k < n:
            # k 处 dd >= 0，已恢复到前高
            events.append({
                "peak_date": peak_date,
                "peak_value": round(float(peak_val), 4),
                "trough_date": str(dates[trough_idx]),
                "trough_value": round(float(trough_val), 4),
                "recovery_date": str(dates[k]),
                "max_drawdown": round(max_dd, 6),
                "down_duration": int(trough_idx - peak_idx),
                "recovery_duration": int(k - trough_idx),
                "total_duration": int(k - peak_idx),
                "recovered": True,
            })
        else:
            events.append({
                "peak_date": peak_date,
                "peak_value": round(float(peak_val), 4),
                "trough_date": str(dates[trough_idx]),
                "trough_value": round(float(trough_val), 4),
                "recovery_date": None,
                "max_drawdown": round(max_dd, 6),
                "down_duration": int(trough_idx - peak_idx),
                "recovery_duration": None,
                "total_duration": None,
                "recovered": False,
            })
        i = k
    return events


def max_drawdown(close: np.ndarray) -> Dict:
    """整体最大回撤。返回 (max_dd, peak_idx, trough_idx, peak_date/trough_date 由调用方填)。"""
    c = np.asarray(close, dtype=float)
    if c.size == 0:
        return {"max_dd": None, "peak_idx": None, "trough_idx": None}
    cm = np.maximum.accumulate(c)
    dd = c / cm - 1.0
    trough_idx = int(np.argmin(dd))
    max_dd = float(dd[trough_idx])
    peak_val = cm[trough_idx]
    # 峰值日为 trough 之前最近一次达到该累计峰值的位置
    peak_idx = int(np.max(np.where(c[: trough_idx + 1] >= peak_val - 1e-12)[0]))
    return {"max_dd": max_dd, "peak_idx": peak_idx, "trough_idx": trough_idx}


def underwater_ratios(close: np.ndarray, thresholds: Sequence[float]) -> Dict:
    """处于回撤 {threshold}% 以下的交易日比例（DD <= -threshold）。"""
    c = np.asarray(close, dtype=float)
    cm = np.maximum.accumulate(c)
    dd = c / cm - 1.0
    out: Dict = {}
    for t in thresholds:
        t = float(t)
        out[f"{t:g}"] = {
            "threshold_pct": t,
            "days": int(np.sum(dd <= -t / 100.0)),
            "ratio_pct": float(np.mean(dd <= -t / 100.0) * 100.0),
            "n": int(c.size),
        }
    return out


def longest_streaks(close: np.ndarray, dates: Sequence[str]) -> Dict:
    """最长连续未创新高（水下连续区间）与最长未回本区间。"""
    c = np.asarray(close, dtype=float)
    cm = np.maximum.accumulate(c)
    dd = c / cm - 1.0
    underwater = dd < -1e-12

    # 最长连续水下（未创新高）区间
    best_len = 0
    best_start = 0
    best_end = -1
    cur_len = 0
    cur_start = 0
    for i in range(c.size):
        if underwater[i]:
            if cur_len == 0:
                cur_start = i
            cur_len += 1
            if cur_len > best_len:
                best_len = cur_len
                best_start = cur_start
                best_end = i
        else:
            cur_len = 0

    return {
        "longest_underwater_days": best_len,
        "longest_underwater_start": str(dates[best_start]) if best_len else None,
        "longest_underwater_end": str(dates[best_end]) if best_len else None,
    }


def rolling_max_drawdown(close: np.ndarray, window: int) -> Dict:
    """滚动 window 交易日内的最大回撤（按日历交易日）。返回 {dates_index, values}（长度与 close 相同，前 window-1 为 null）。"""
    c = np.asarray(close, dtype=float)
    n = c.size
    out = [None] * n
    if n == 0:
        return {"window": window, "values": [], "n": 0}
    for t in range(window - 1, n):
        seg = c[t - window + 1: t + 1]
        cm = np.maximum.accumulate(seg)
        out[t] = float((seg / cm - 1.0).min())
    return {"window": window, "values": out, "n": n}


# --------------------------------------------------------------------------- #
# 持有期收益
# --------------------------------------------------------------------------- #
def holding_returns(close: np.ndarray, horizons: Sequence[int]) -> Dict:
    """
    对每个可用起点 t 计算 R_(t,h)=Close_{t+h}/Close_t - 1（只有存在第 t+h 个交易日才纳入）。
    返回 {str(h): {"returns_pct": [...], "n": ..., 汇总}}。
    注意：滚动窗口收益高度相关，非独立实验。
    """
    c = np.asarray(close, dtype=float)
    n = c.size
    out: Dict = {}
    for h in horizons:
        h = int(h)
        if h <= 0 or h >= n:
            out[str(h)] = {"returns_pct": [], "n": 0}
            continue
        rets = (c[h:] / c[:-h] - 1.0) * 100.0  # 长度 n-h，起点 t=0..n-h-1
        arr = np.asarray(rets, dtype=float)
        q = quantiles(arr, [5, 25, 50, 75, 95]) if arr.size else {}
        out[str(h)] = {
            "returns_pct": [round(float(x), 4) for x in arr],
            "n": int(arr.size),
            "win_rate_pct": float(np.mean(arr > 0) * 100.0) if arr.size else None,
            "loss_gt5_pct": float(np.mean(arr <= -5.0) * 100.0) if arr.size else None,
            "loss_gt10_pct": float(np.mean(arr <= -10.0) * 100.0) if arr.size else None,
            "loss_gt20_pct": float(np.mean(arr <= -20.0) * 100.0) if arr.size else None,
            "mean_pct": float(np.mean(arr)) if arr.size else None,
            "median_pct": float(np.median(arr)) if arr.size else None,
            "min_pct": float(np.min(arr)) if arr.size else None,
            "max_pct": float(np.max(arr)) if arr.size else None,
            "p5_pct": q.get("5") if q else None,
            "p25_pct": q.get("25") if q else None,
            "p75_pct": q.get("75") if q else None,
            "p95_pct": q.get("95") if q else None,
        }
    return out
