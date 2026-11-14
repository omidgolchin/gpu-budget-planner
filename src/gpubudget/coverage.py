"""Forecast-interval coverage: does the simulated price range contain the
real price as often as it claims?

Walk-forward on the daily series: for each held-out calendar month, paths
are simulated from the planner's start level (the median of the last 30
training days), using only returns from before it (block bootstrap, as in
the engine). A held-out day counts as covered when the real price falls
inside that day's simulated 5-95% band. Computed once, when the data is
processed (scripts/process_data.py); the page only displays the result.
"""

from .engine import log_returns, mulberry32, percentile, start_price

_EPS = 1e-12


def simulate_band(train_prices, horizon, count, seed, block=28):
    """Per-day (lo, hi) 5-95% band for the ``horizon`` days after the
    training window, from block-bootstrapped paths starting at
    start_price(train_prices)."""
    rets = log_returns(train_prices)
    n = len(rets)
    L = min(block, n) if n else 0
    starts = n - L + 1
    cols = [[] for _ in range(horizon)]
    for i in range(count):
        rand = mulberry32(seed + 7919 * i)
        price = start_price(train_prices)
        drawn = []
        while len(drawn) < horizon:
            j = int(rand() * starts)
            drawn.extend(rets[j:j + L])
        for t in range(horizon):
            price *= _exp(drawn[t])
            cols[t].append(price)
    return [(percentile(sorted(c), 0.05), percentile(sorted(c), 0.95)) for c in cols]


def _exp(x):
    import math
    return math.exp(x)


def month_starts(dates):
    """Index of the first day of each calendar month in ``dates``
    (ISO strings), as [(start_index, 'YYYY-MM'), ...]."""
    out = []
    seen = set()
    for i, d in enumerate(dates):
        key = d[:7]
        if key not in seen:
            seen.add(key)
            out.append((i, key))
    return out


def band_coverage(dates, prices, holdout_months=2, count=200, seed=7, block=28):
    """Coverage over the last ``holdout_months`` calendar months.

    Returns {"covered": int, "days": int, "pct": float, "months": [...]}.
    """
    starts = month_starts(dates)
    if len(starts) <= holdout_months:
        raise ValueError("series too short for that many held-out months")
    held = starts[-holdout_months:]
    covered = 0
    total = 0
    months = []
    for k, (start, key) in enumerate(held):
        end = held[k + 1][0] if k + 1 < len(held) else len(prices)
        horizon = end - start
        band = simulate_band(prices[:start], horizon, count, seed, block)
        c = 0
        for t in range(horizon):
            lo, hi = band[t]
            actual = prices[start + t]
            if lo - _EPS <= actual <= hi + _EPS:
                c += 1
        covered += c
        total += horizon
        months.append({"month": key, "covered": c, "days": horizon})
    return {"covered": covered, "days": total,
            "pct": covered / total if total else 0.0, "months": months}
