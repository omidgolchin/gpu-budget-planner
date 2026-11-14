"""Coverage backtest: exact answers on constructed series."""

from datetime import date, timedelta

from gpubudget.coverage import band_coverage


def _dates(n, start=date(2024, 1, 1)):
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


def test_constant_series_is_fully_covered():
    # No movement at all: the band is the price itself, every day covered.
    out = band_coverage(_dates(120), [2.0] * 120, holdout_months=1, count=50)
    assert out["pct"] == 1.0
    assert out["covered"] == out["days"]


def test_a_jump_at_the_boundary_is_never_covered():
    # Three months flat at 1.0, then the held-out month at 3.0. Training
    # returns are all zero, so the band sits at 1.0 and misses every day.
    prices = [1.0] * 91 + [3.0] * 29
    out = band_coverage(_dates(120), prices, holdout_months=1, count=50)
    assert out["pct"] == 0.0
    assert out["covered"] == 0
    assert out["months"][0]["month"] == "2024-04"
