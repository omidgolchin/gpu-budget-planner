"""The GPU Budget Planner engine: what each way of buying GPU-hours costs,
and how sure you can be of the bill.

Model (kept deliberately simple, and stated on the page):

- The job needs ``hours`` GPU-hours of finished work inside ``weeks`` weeks
  (``days = 7 * weeks``). Work is spread evenly: the base rate is
  ``hours / days`` GPU-hours per day.
- A strategy splits that daily work between reserved capacity (a fixed
  price, always there), on-demand (a fixed price, always there) and spot.
- Spot prices follow simulated daily price paths: a block bootstrap of the
  observed daily log returns (block length 28 days), so runs of high and
  low prices persist. All strategies are scored on the same paths.
- Spot capacity is yours while the day's spot price is at or below the cap
  (default: the on-demand price, the usual bid). A day the price crosses
  above the cap reclaims the spot work in flight: the work done since the
  last checkpoint is lost and has to be redone. Checkpoints are taken
  every ``ckpt_hours`` of spot running; an interruption lands at a uniform
  point in the checkpoint cycle, so the expected loss is half an interval
  of work at the plan's base spot rate. Work that cannot run waits in a
  backlog; the spot fleet can catch up at up to three times its base rate
  on a later day.
- A reservation is a commitment. With ``term_hours`` set, the reserved
  share runs on whole GPUs reserved for whole terms: enough GPUs to do
  that share by the deadline, paid for every hour of every term needed to
  cover it, used or not. With ``term_hours`` None the reserved share is
  charged only for the hours this job uses (the reserved GPUs go on to
  other work after the deadline).
- Spot nodes are also reclaimed for capacity, whatever the price: since
  the end of 2017 AWS has not interrupted spot instances over competing
  bids, and prices move slowly; reclaims come when EC2 needs the capacity
  back. Each running node is reclaimed at a constant rate
  (``reclaim`` per node-hour; nodes hold ``gpn`` GPUs). A training job
  that runs its nodes in lockstep stops whenever any one of them goes, so
  each reclaim costs the whole fleet half a checkpoint interval of work.
  Reclaims per day are Poisson, drawn by inverse transform from one
  uniform per day and path, shared by every strategy (common random
  numbers). ``reclaim = 0`` is the price-cap-only model.
- A strategy with an on-demand fallback does any spot work that is still
  undone in the last week on on-demand instead of deferring it, so it
  cannot finish late. Any other strategy that ends the window with a
  backlog misses the deadline and finishes the rest on on-demand, late,
  at the on-demand price.

This module mirrors docs/gpuplan.js function for function, including the
random number generator, so the page and the reference agree exactly.
"""

import math

# The strategy menu. fr/fs/fd: shares of the daily work; fb: on-demand
# fallback in the last week.
STRATEGIES = [
    {"id": "reserved", "name": "All reserved", "short": "Reserved",
     "fr": 1.0, "fs": 0.0, "fd": 0.0, "fb": False},
    {"id": "ondemand", "name": "All on-demand", "short": "On demand",
     "fr": 0.0, "fs": 0.0, "fd": 1.0, "fb": False},
    {"id": "spot", "name": "All spot", "short": "Spot",
     "fr": 0.0, "fs": 1.0, "fd": 0.0, "fb": False},
    {"id": "spotfb", "name": "All spot, on-demand fallback in the last week",
     "short": "Spot + fallback", "fr": 0.0, "fs": 1.0, "fd": 0.0, "fb": True},
    {"id": "mix25", "name": "Reserve 25%, spot for the rest", "short": "25% reserved",
     "fr": 0.25, "fs": 0.75, "fd": 0.0, "fb": True},
    {"id": "mix50", "name": "Reserve 50%, spot for the rest", "short": "50% reserved",
     "fr": 0.50, "fs": 0.50, "fd": 0.0, "fb": True},
    {"id": "mix60", "name": "Reserve 60%, spot for the rest", "short": "60% reserved",
     "fr": 0.60, "fs": 0.40, "fd": 0.0, "fb": True},
    {"id": "mix75", "name": "Reserve 75%, spot for the rest", "short": "75% reserved",
     "fr": 0.75, "fs": 0.25, "fd": 0.0, "fb": True},
]

MISS_OK = 0.05        # a plan may miss the deadline in at most 5% of runs
OVER_OK = 0.20        # ... and run over budget in at most 20% of runs
WARN_MISS = 0.02      # above this miss rate the verdict warns


def mulberry32(seed):
    """The same seeded RNG the browser engine uses (bit-exact)."""
    a = seed & 0xFFFFFFFF

    def rand():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        inner = ((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF
        t = ((t + inner) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rand


def log_returns(prices):
    return [math.log(prices[i + 1] / prices[i]) for i in range(len(prices) - 1)]


def _path_from_returns(start, rets):
    prices = [start]
    for r in rets:
        prices.append(prices[-1] * math.exp(r))
    return prices


def start_price(spot):
    """Where simulated paths begin: the median of the last 30 observed
    days (the level the shipped series was anchored to), not one noisy
    last day."""
    return percentile(sorted(spot[-30:]), 0.5)


def sample_paths(spot, days, count, seed, block=28):
    """Block-bootstrap price paths of length ``days`` from the daily spot
    series. Path i uses mulberry32(seed + 7919*i); the same paths are used
    for every strategy."""
    rets = log_returns(spot)
    n = len(rets)
    if n == 0 or days <= 1:
        return [[spot[-1]] * max(days, 1) for _ in range(count)]
    L = min(block, n)
    starts = n - L + 1
    paths = []
    for i in range(count):
        rand = mulberry32(seed + 7919 * i)
        drawn = []
        while len(drawn) < days - 1:
            j = int(rand() * starts)
            drawn.extend(rets[j:j + L])
        paths.append(_path_from_returns(start_price(spot), drawn[:days - 1]))
    return paths


def iid_returns(spot, days, count, seed):
    """The naive resample: each day's return drawn on its own. Used in the
    details panel to show what the block bootstrap protects against."""
    rets = log_returns(spot)
    n = len(rets)
    paths = []
    for i in range(count):
        rand = mulberry32(seed + 7919 * i + 1)
        drawn = [rets[int(rand() * n)] for _ in range(max(days - 1, 0))]
        paths.append(_path_from_returns(start_price(spot), drawn))
    return paths


def poisson_inv(u, mean):
    """Smallest k with P(Poisson(mean) <= k) >= u. Inverse transform, so
    one uniform per day gives the day's reclaim count; the same ops in
    docs/gpuplan.js."""
    if mean <= 0:
        return 0
    k = 0
    p = math.exp(-mean)
    cdf = p
    while u > cdf and k < 1000:
        k += 1
        p *= mean / k
        cdf += p
    return k


def reclaim_rate(per_node_day):
    """Reclaims per node-hour from reclaims per node-day."""
    return per_node_day / 24.0


def reserved_cost(fr, hours, days, p_res, term_hours=None):
    """What reserving share ``fr`` of the job costs (see module notes)."""
    if fr <= 0:
        return 0.0
    if term_hours is None:
        return fr * hours * p_res
    gpus = math.ceil(fr * hours / (days * 24.0) - 1e-9)
    terms = math.ceil(days * 24.0 / term_hours - 1e-9)
    return gpus * terms * term_hours * p_res


def run_strategy(prices, strat, hours, p_res, p_od, cap, ckpt_hours,
                 reclaim=0.0, gpn=8, us=None, term_hours=None):
    """Run one strategy over one price path. Returns cost and risk facts.
    ``reclaim``: capacity reclaims per node-hour; ``us``: one uniform per
    day for the reclaim draws (no capacity reclaims without it)."""
    days = len(prices)
    q = hours / days
    fs, fr, fd = strat["fs"], strat["fr"], strat["fd"]
    fixed = reserved_cost(fr, hours, days, p_res, term_hours) + fd * hours * p_od
    if fs <= 0:
        return {"cost": fixed, "missed": False, "interruptions": 0,
                "lost_hours": 0.0, "spot_hours": 0.0}
    spot_rate = fs * q / 24.0            # GPU-hours per wall-hour, base rate
    backlog = 0.0
    lost_total = 0.0
    interruptions = 0
    spot_cost = 0.0
    spot_hours = 0.0
    prev_avail = True
    for t in range(days):
        price = prices[t]
        avail = price <= cap
        if not avail and prev_avail:
            # Expected work since the last checkpoint: half an interval.
            lost = spot_rate * ckpt_hours / 2.0 if ckpt_hours > 0 else 0.0
            backlog += lost
            lost_total += lost
            interruptions += 1
        want = fs * q + backlog
        done = 0.0
        if avail:
            done = min(want, 3.0 * fs * q)
            spot_cost += done * price
            spot_hours += done
            if reclaim > 0 and us is not None and done > 0:
                # Capacity reclaims: node-hours run today = GPU-hours / gpn.
                # Each reclaim stops the lockstep fleet and throws away half
                # a checkpoint interval of its work: paid for, not progress.
                k = poisson_inv(us[t], reclaim * done / gpn)
                if k:
                    lost = min(done, k * (done / 24.0) * ckpt_hours / 2.0)
                    done -= lost
                    lost_total += lost
                    interruptions += k
        rem = want - done
        if strat["fb"] and t >= days - 7 and rem > 0:
            spot_cost += rem * p_od
            spot_hours += rem
            rem = 0.0
        backlog = rem
        prev_avail = avail
    missed = backlog > 1e-9
    if missed:
        spot_cost += backlog * p_od      # finish late, on on-demand
    return {"cost": fixed + spot_cost, "missed": missed,
            "interruptions": interruptions, "lost_hours": lost_total,
            "spot_hours": spot_hours}


def percentile(sorted_vals, p):
    """Linear-interpolation percentile (numpy's default), on sorted data."""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    rank = p * (n - 1)
    lo = int(math.floor(rank))
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def summarize(costs, missed_flags, budget):
    s = sorted(costs)
    p95 = percentile(s, 0.95)
    worst = [c for c in s if c >= p95]
    out = {
        "median": percentile(s, 0.50),
        "p5": percentile(s, 0.05),
        "p25": percentile(s, 0.25),
        "p75": percentile(s, 0.75),
        "p95": p95,
        "es95": sum(worst) / len(worst),   # Acerbi & Tasche (2002): mean of the worst 5%
        "mean": sum(s) / len(s),
        "p_miss": sum(1 for m in missed_flags if m) / len(missed_flags),
    }
    if budget is not None:
        out["p_over"] = sum(1 for c in s if c > budget) / len(s)
    else:
        out["p_over"] = None
    return out


def recommend(stats, budget):
    """Pick the strategy and the verdict class. stats: {id: summarize(...)}.

    Rules, in order:
    - If a budget is set and even the cheapest deadline-proof plan (all
      reserved or all on-demand; both always finish on time) has a median
      bill above it, the budget cannot be met: class v-bad.
    - Feasible plans finish on time in at least 95% of runs. Among them,
      with a budget, prefer plans over budget in at most 20% of runs; take
      the lowest median bill, counting bills within 0.5% of it as a tie
      that goes to the plan least likely to finish late.
    - If no plan is feasible, take the one that misses least: v-warn.
    - v-accent when the winner is a fixed-price plan and spot would have
      saved less than 2%: the sure thing wins, say so.
    - v-warn when the winner still misses in over 2% of runs or runs over
      budget in over 20% of runs; otherwise v-good.
    """
    by_id = {s["id"]: stats[s["id"]] for s in STRATEGIES}
    guaranteed = [by_id["reserved"], by_id["ondemand"]]
    cheapest_safe = min(g["median"] for g in guaranteed)
    if budget is not None and cheapest_safe > budget:
        best = min(guaranteed, key=lambda g: g["median"])
        sid = "reserved" if best is by_id["reserved"] else "ondemand"
        return {"id": sid, "cls": "v-bad", "reason": "budget-infeasible"}
    feasible = [s for s in STRATEGIES if by_id[s["id"]]["p_miss"] <= MISS_OK]
    if feasible:
        pool = feasible
        if budget is not None:
            calm = [s for s in feasible if (by_id[s["id"]]["p_over"] or 0) <= OVER_OK]
            if calm:
                pool = calm
        # Bills within half a percent of the cheapest are a tie; the tie
        # goes to the plan that misses the deadline least, then the one
        # over budget least, then the cheaper.
        best_med = min(by_id[s["id"]]["median"] for s in pool)
        near = [s for s in pool if by_id[s["id"]]["median"] <= best_med * 1.005]
        win = min(near, key=lambda s: (by_id[s["id"]]["p_miss"],
                                       by_id[s["id"]]["p_over"] or 0,
                                       by_id[s["id"]]["median"]))
        w = by_id[win["id"]]
        cheapest = min(by_id[s["id"]]["median"] for s in STRATEGIES)
        if win["id"] in ("reserved", "ondemand") and w["median"] <= cheapest * 1.02:
            return {"id": win["id"], "cls": "v-accent", "reason": "sure-thing"}
        if w["p_miss"] > WARN_MISS or (w["p_over"] or 0) > OVER_OK:
            return {"id": win["id"], "cls": "v-warn", "reason": "risky-winner"}
        return {"id": win["id"], "cls": "v-good", "reason": "clean"}
    win = min(STRATEGIES, key=lambda s: (by_id[s["id"]]["p_miss"],
                                         by_id[s["id"]]["median"]))
    return {"id": win["id"], "cls": "v-warn", "reason": "nothing-feasible"}


def reclaim_uniforms(days, count, seed):
    """One uniform per day per path for the capacity-reclaim draws, on a
    stream separate from the price paths."""
    out = []
    for i in range(count):
        rand = mulberry32(seed + 104729 * i + 5)
        out.append([rand() for _ in range(days)])
    return out


def plan(spot, hours, weeks, budget, ckpt_hours, p_res, p_od,
         cap=None, paths_n=400, seed=42, block=28, reclaim=0.0, gpn=8,
         term_hours=None):
    """Full evaluation. ``spot`` is the observed daily spot price series
    (per GPU-hour); paths start from start_price(spot). ``reclaim`` is
    capacity reclaims per node-hour (0: price cap only)."""
    days = int(weeks) * 7
    if cap is None:
        cap = p_od
    paths = sample_paths(spot, days, paths_n, seed, block)
    us_all = reclaim_uniforms(days, paths_n, seed)
    stats = {}
    detail = {}
    for strat in STRATEGIES:
        costs, misses, ints, lost = [], [], [], []
        for path, us in zip(paths, us_all):
            r = run_strategy(path, strat, hours, p_res, p_od, cap, ckpt_hours,
                             reclaim, gpn, us, term_hours)
            costs.append(r["cost"])
            misses.append(r["missed"])
            ints.append(r["interruptions"])
            lost.append(r["lost_hours"])
        stats[strat["id"]] = summarize(costs, misses, budget)
        detail[strat["id"]] = {
            "interruptions": sum(ints) / len(ints),
            "lost_hours": sum(lost) / len(lost),
        }
    rec = recommend(stats, budget)
    # Fan chart data: per-day spot price percentiles across the paths.
    fan = {"p5": [], "p50": [], "p95": []}
    for t in range(days):
        col = sorted(path[t] for path in paths)
        fan["p5"].append(percentile(col, 0.05))
        fan["p50"].append(percentile(col, 0.50))
        fan["p95"].append(percentile(col, 0.95))
    # What the naive i.i.d. resample would say about the all-spot bill.
    iid_paths = iid_returns(spot, days, paths_n, seed)
    spot_strat = next(s for s in STRATEGIES if s["id"] == "spot")
    iid_costs = sorted(
        run_strategy(p, spot_strat, hours, p_res, p_od, cap, ckpt_hours,
                     reclaim, gpn, us, term_hours)["cost"]
        for p, us in zip(iid_paths, us_all))
    return {
        "days": days,
        "strategies": [
            {**{k: strat[k] for k in ("id", "name", "short")},
             **stats[strat["id"]], **detail[strat["id"]]}
            for strat in STRATEGIES
        ],
        "recommendation": rec,
        "fan": fan,
        "iid_spot_median": percentile(iid_costs, 0.50),
        "block_spot_median": stats["spot"]["median"],
    }
