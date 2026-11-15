"""Engine tests: the spec's cases, on hand-checkable numbers."""

import json
from pathlib import Path

import pytest

from gpubudget import engine

ROOT = Path(__file__).resolve().parents[1]
PRICES = json.loads((ROOT / "docs" / "data" / "prices.json").read_text())


def _by_id(out):
    return {s["id"]: s for s in out["strategies"]}


def test_zero_volatility_every_strategy_costs_the_hand_calculation():
    # Constant spot price: no interruptions, no misses, no spread. Every
    # strategy's bill is then just its shares times the fixed prices.
    out = engine.plan([1.5] * 120, 1000, 6, None, 2.0, 2.5, 3.0, paths_n=50)
    s = _by_id(out)
    # Fixed-price strategies are computed in closed form: exact.
    assert s["reserved"]["median"] == 1000 * 2.5
    assert s["ondemand"]["median"] == 1000 * 3.0
    # Simulated strategies accumulate day by day: hand value to float dust.
    assert s["spot"]["median"] == pytest.approx(1000 * 1.5, rel=1e-9)
    assert s["spotfb"]["median"] == pytest.approx(1000 * 1.5, rel=1e-9)
    assert s["mix25"]["median"] == pytest.approx(250 * 2.5 + 750 * 1.5, rel=1e-9)
    assert s["mix50"]["median"] == pytest.approx(500 * 2.5 + 500 * 1.5, rel=1e-9)
    assert s["mix60"]["median"] == pytest.approx(600 * 2.5 + 400 * 1.5, rel=1e-9)
    assert s["mix75"]["median"] == pytest.approx(750 * 2.5 + 250 * 1.5, rel=1e-9)
    for st in s.values():
        assert st["p_miss"] == 0.0
        assert st["p5"] == pytest.approx(st["median"], rel=1e-9)
        assert st["p95"] == pytest.approx(st["median"], rel=1e-9)
        assert st["es95"] == pytest.approx(st["median"], rel=1e-9)


def test_block_bootstrap_preserves_the_mean_price_change():
    spot = PRICES["gpus"]["h100"]["spot"]
    rets = engine.log_returns(spot)
    hist = sum(rets) / len(rets)
    paths = engine.sample_paths(spot, 43, 300, 42)
    drawn = [r for p in paths for r in engine.log_returns(p)]
    assert abs(sum(drawn) / len(drawn) - hist) < 0.002


def test_paths_start_at_the_recent_level_not_the_last_day():
    spot = [5.0] * 70 + [2.0] * 30
    assert engine.start_price(spot) == 2.0
    for p in engine.sample_paths(spot, 20, 10, 1):
        assert p[0] == 2.0


def test_interruption_cost_is_the_hand_computed_lost_work():
    # 10 days: three cheap days, one day over the cap, then cheap again.
    # q = 240/10 = 24 GPU-hours a day, so the spot base rate is 1 GPU-hour
    # per wall-hour. One interruption, checkpoints every 48 hours: the
    # expected loss is half an interval = 24 GPU-hours, redone the next
    # day inside the 3x catch-up cap. Everything still finishes on spot,
    # and the redone work is billed too: 240 + 24 = 264 GPU-hours at $1.
    strat = next(s for s in engine.STRATEGIES if s["id"] == "spot")
    path = [1.0, 1.0, 1.0, 5.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    r = engine.run_strategy(path, strat, 240, 2.5, 3.0, 2.0, 48.0)
    assert r["interruptions"] == 1
    assert r["lost_hours"] == 24.0
    assert r["missed"] is False
    assert r["spot_hours"] == 264.0
    assert r["cost"] == 264.0


def test_checkpoint_frequency_changes_the_winning_strategy():
    # Six cheap days, one spike day, repeating. With hourly checkpoints
    # the lost work is trivial and spot with a fallback wins; with weekly
    # checkpoints the redone work makes reserving cheaper overall.
    pat = ([0.5] * 6 + [4.0]) * 30
    fine = engine.plan(pat, 4200, 6, None, 1.0, 0.8, 2.0, paths_n=200)
    coarse = engine.plan(pat, 4200, 6, None, 168.0, 0.8, 2.0, paths_n=200)
    assert fine["recommendation"]["id"] == "spotfb"
    assert coarse["recommendation"]["id"] == "reserved"


def _stats(**over):
    base = {"median": 5000.0, "p_miss": 0.0, "p_over": None}
    out = {}
    for s in engine.STRATEGIES:
        out[s["id"]] = dict(base)
    for k, v in over.items():
        out[k].update(v)
    return out


def test_recommend_budget_infeasible_is_bad():
    st = _stats(reserved={"median": 5000.0}, ondemand={"median": 6000.0},
                spot={"median": 900.0})
    rec = engine.recommend(st, 100.0)
    assert rec == {"id": "reserved", "cls": "v-bad", "reason": "budget-infeasible"}


def test_recommend_sure_thing_is_accent():
    st = _stats(reserved={"median": 1000.0}, spot={"median": 1005.0},
                spotfb={"median": 1010.0}, ondemand={"median": 1100.0},
                mix25={"median": 1020.0}, mix50={"median": 1030.0},
                mix60={"median": 1040.0}, mix75={"median": 1050.0})
    rec = engine.recommend(st, None)
    assert rec == {"id": "reserved", "cls": "v-accent", "reason": "sure-thing"}


def test_recommend_clean_winner_is_good():
    st = _stats(spot={"median": 900.0})
    rec = engine.recommend(st, None)
    assert rec == {"id": "spot", "cls": "v-good", "reason": "clean"}


def test_recommend_risky_winner_warns():
    st = _stats(spot={"median": 900.0, "p_miss": 0.04})
    rec = engine.recommend(st, None)
    assert rec == {"id": "spot", "cls": "v-warn", "reason": "risky-winner"}


def test_recommend_budget_prefers_calm_plans_then_warns_when_none_calm():
    st = _stats(spot={"median": 900.0, "p_over": 0.5},
                reserved={"median": 2000.0, "p_over": 0.3},
                ondemand={"median": 2100.0, "p_over": 0.35},
                spotfb={"median": 1500.0, "p_over": 0.4},
                mix25={"median": 1600.0, "p_over": 0.4},
                mix50={"median": 1700.0, "p_over": 0.4},
                mix60={"median": 1800.0, "p_over": 0.4},
                mix75={"median": 1900.0, "p_over": 0.4})
    rec = engine.recommend(st, 2500.0)
    assert rec == {"id": "spot", "cls": "v-warn", "reason": "risky-winner"}


def test_recommend_nothing_feasible_warns():
    st = _stats(**{s["id"]: {"p_miss": 0.3} for s in engine.STRATEGIES})
    st["spot"]["p_miss"] = 0.2
    st["spot"]["median"] = 900.0
    rec = engine.recommend(st, None)
    assert rec == {"id": "spot", "cls": "v-warn", "reason": "nothing-feasible"}


def test_expected_shortfall_is_the_worst_five_percent_mean():
    costs = [100.0] * 19 + [1000.0]
    out = engine.summarize(costs, [False] * 20, 500.0)
    assert out["median"] == 100.0
    assert out["p95"] == pytest.approx(145.0)  # linear interpolation, numpy's way
    assert out["es95"] == 1000.0        # only the 1000 run is at or over p95
    assert out["es95"] >= out["p95"]
    assert out["p_over"] == 0.05


def test_es95_never_below_p95_on_real_output():
    spot = PRICES["gpus"]["a100"]["spot"]
    out = engine.plan(spot, 3000, 5, 6000.0, 2.0, 1.65, 1.91, paths_n=100)
    for s in out["strategies"]:
        assert s["es95"] >= s["p95"] >= s["median"] >= s["p5"]
        assert 0.0 <= s["p_miss"] <= 1.0
        assert 0.0 <= s["p_over"] <= 1.0


def test_poisson_inverse_transform():
    """The reclaim count per day is Poisson by inverse transform: the
    mean of many draws matches, and u below e^-m gives zero."""
    import random
    rng = random.Random(1)
    draws = [engine.poisson_inv(rng.random(), 0.7) for _ in range(40000)]
    assert abs(sum(draws) / len(draws) - 0.7) < 0.02
    assert engine.poisson_inv(0.3, 1.0) == 0          # e^-1 = 0.368
    assert engine.poisson_inv(0.5, 0.0) == 0


def test_capacity_reclaims_match_hand_calculation():
    """Flat prices below the cap, so only capacity reclaims interrupt.
    Reclaims = rate x node-hours actually run (redone work runs too), and
    each costs half a checkpoint interval of the lockstep fleet's work:
    at least the base fleet's, at most the 3x catch-up fleet's."""
    days, hours, gpn, ckpt = 28, 28 * 24 * 64.0, 8, 4.0   # 64 GPUs, 8 nodes
    rate = 1 / 48                                          # per node-hour
    path = [2.0] * days
    strat = next(s for s in engine.STRATEGIES if s["id"] == "spot")
    us = engine.reclaim_uniforms(days, 400, 3)
    runs = [engine.run_strategy(path, strat, hours, 2.5, 3.0, 3.0, ckpt, rate, gpn, u) for u in us]
    ints = sum(r["interruptions"] for r in runs)
    node_hours = sum(r["spot_hours"] for r in runs) / gpn
    assert abs(ints - rate * node_hours) / (rate * node_hours) < 0.03
    per = sum(r["lost_hours"] for r in runs) / ints
    assert 64 * ckpt / 2 * 0.99 <= per <= 3 * 64 * ckpt / 2
    # no reclaims, no loss: the price-cap-only model is unchanged
    r0 = engine.run_strategy(path, strat, hours, 2.5, 3.0, 3.0, ckpt, 0.0, gpn, us[0])
    assert r0["interruptions"] == 0 and r0["lost_hours"] == 0.0


def test_reclaims_make_checkpoints_matter_on_a_big_job():
    """On a big lockstep job with frequent reclaims, weekly checkpoints
    cost far more than hourly ones; on a tiny job they barely differ."""
    spot = [1.5] * 120
    big = dict(hours=40000, weeks=4, budget=None, p_res=2.5, p_od=3.0)
    fine = engine.plan(spot, big["hours"], big["weeks"], None, 1.0, 2.5, 3.0, paths_n=60, reclaim=1 / 24)
    coarse = engine.plan(spot, big["hours"], big["weeks"], None, 24.0, 2.5, 3.0, paths_n=60, reclaim=1 / 24)
    f = {s["id"]: s for s in fine["strategies"]}["spotfb"]
    c = {s["id"]: s for s in coarse["strategies"]}["spotfb"]
    assert c["median"] > 1.2 * f["median"]


def test_reservation_is_a_commitment():
    """2,000 GPU-hours in 6 weeks needs 2 GPUs (1.98, rounded up). On a
    12-month term the reservation pays for 2 GPUs x 8,760 hours whether
    or not they are used; on a 1-month term, two terms cover 6 weeks.
    Without a term (the GPUs go on to other work) only the job's hours
    are charged."""
    assert engine.reserved_cost(1.0, 2000, 42, 3.0, 8760.0) == 2 * 8760 * 3.0
    assert engine.reserved_cost(1.0, 2000, 42, 3.0, 730.0) == 2 * 2 * 730 * 3.0
    assert engine.reserved_cost(1.0, 2000, 42, 3.0, None) == 2000 * 3.0
    assert engine.reserved_cost(0.5, 2000, 42, 3.0, 730.0) == 1 * 2 * 730 * 3.0
    assert engine.reserved_cost(0.0, 2000, 42, 3.0, 730.0) == 0.0
    out = engine.plan([1.5] * 120, 2000, 6, None, 2.0, 3.0, 3.5, paths_n=20, term_hours=8760.0)
    s = {x["id"]: x for x in out["strategies"]}
    assert s["reserved"]["median"] == 2 * 8760 * 3.0
    assert out["recommendation"]["id"] != "reserved"
