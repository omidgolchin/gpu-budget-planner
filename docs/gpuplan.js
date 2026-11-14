/* GPU Budget Planner engine. Mirrors src/gpubudget/engine.py function for
 * function, including the seeded RNG, so the page and the Python reference
 * agree exactly (checked by tests/test_js_agreement.py).
 *
 * The model, in short: the job needs `hours` GPU-hours inside `weeks`
 * weeks, spread evenly. A strategy splits the daily work between reserved
 * capacity, on-demand and spot. Spot prices follow block-bootstrapped
 * daily price paths (28-day blocks, so price runs persist). Spot capacity
 * is yours while the day's price is at or below the cap; crossing above
 * it reclaims the spot work done since the last checkpoint, which then
 * has to be redone (an interruption lands at a uniform point in the
 * checkpoint cycle, so the expected loss is half an interval of work).
 * Work that cannot run waits in a backlog; the spot
 * fleet can catch up at up to 3x its base rate. A strategy with an
 * on-demand fallback does any undone spot work in the last week on
 * on-demand, so it cannot finish late; any other strategy that ends with
 * a backlog misses the deadline and finishes late at the on-demand price.
 */
(function (g) {
  "use strict";

  var STRATEGIES = [
    { id: "reserved", name: "All reserved", short: "Reserved", fr: 1.0, fs: 0.0, fd: 0.0, fb: false },
    { id: "ondemand", name: "All on-demand", short: "On demand", fr: 0.0, fs: 0.0, fd: 1.0, fb: false },
    { id: "spot", name: "All spot", short: "Spot", fr: 0.0, fs: 1.0, fd: 0.0, fb: false },
    { id: "spotfb", name: "All spot, on-demand fallback in the last week", short: "Spot + fallback", fr: 0.0, fs: 1.0, fd: 0.0, fb: true },
    { id: "mix25", name: "Reserve 25%, spot for the rest", short: "25% reserved", fr: 0.25, fs: 0.75, fd: 0.0, fb: true },
    { id: "mix50", name: "Reserve 50%, spot for the rest", short: "50% reserved", fr: 0.50, fs: 0.50, fd: 0.0, fb: true },
    { id: "mix60", name: "Reserve 60%, spot for the rest", short: "60% reserved", fr: 0.60, fs: 0.40, fd: 0.0, fb: true },
    { id: "mix75", name: "Reserve 75%, spot for the rest", short: "75% reserved", fr: 0.75, fs: 0.25, fd: 0.0, fb: true }
  ];
  var MISS_OK = 0.05, OVER_OK = 0.20, WARN_MISS = 0.02;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function logReturns(prices) {
    var out = [];
    for (var i = 0; i + 1 < prices.length; i++) out.push(Math.log(prices[i + 1] / prices[i]));
    return out;
  }
  function pathFromReturns(start, rets) {
    var prices = [start];
    for (var i = 0; i < rets.length; i++) prices.push(prices[prices.length - 1] * Math.exp(rets[i]));
    return prices;
  }
  function startPrice(spot) {
    var tail = spot.slice(-30).sort(function (a, b) { return a - b; });
    return percentile(tail, 0.5);
  }
  function samplePaths(spot, days, count, seed, block) {
    block = block || 28;
    var rets = logReturns(spot), n = rets.length, paths = [], i, j, k;
    if (n === 0 || days <= 1) {
      for (i = 0; i < count; i++) { var flat = []; for (k = 0; k < Math.max(days, 1); k++) flat.push(spot[spot.length - 1]); paths.push(flat); }
      return paths;
    }
    var L = Math.min(block, n), starts = n - L + 1;
    for (i = 0; i < count; i++) {
      var rand = mulberry32(seed + 7919 * i), drawn = [];
      while (drawn.length < days - 1) {
        j = Math.floor(rand() * starts);
        for (k = 0; k < L; k++) drawn.push(rets[j + k]);
      }
      paths.push(pathFromReturns(startPrice(spot), drawn.slice(0, days - 1)));
    }
    return paths;
  }
  function iidPaths(spot, days, count, seed) {
    var rets = logReturns(spot), n = rets.length, paths = [];
    for (var i = 0; i < count; i++) {
      var rand = mulberry32(seed + 7919 * i + 1), drawn = [];
      for (var t = 0; t < Math.max(days - 1, 0); t++) drawn.push(rets[Math.floor(rand() * n)]);
      paths.push(pathFromReturns(startPrice(spot), drawn));
    }
    return paths;
  }

  function runStrategy(prices, strat, hours, pRes, pOd, cap, ckptHours) {
    var days = prices.length, q = hours / days;
    var fixed = strat.fr * hours * pRes + strat.fd * hours * pOd;
    if (strat.fs <= 0) return { cost: fixed, missed: false, interruptions: 0, lostHours: 0, spotHours: 0 };
    var spotRate = strat.fs * q / 24, backlog = 0, lostTotal = 0;
    var interruptions = 0, spotCost = 0, spotHours = 0, prevAvail = true;
    for (var t = 0; t < days; t++) {
      var price = prices[t], avail = price <= cap;
      if (!avail && prevAvail) {
        var lost = ckptHours > 0 ? spotRate * ckptHours / 2 : 0;
        backlog += lost; lostTotal += lost; interruptions++;
      }
      var want = strat.fs * q + backlog, done = 0;
      if (avail) {
        done = Math.min(want, 3 * strat.fs * q);
        spotCost += done * price; spotHours += done;
      }
      var rem = want - done;
      if (strat.fb && t >= days - 7 && rem > 0) { spotCost += rem * pOd; spotHours += rem; rem = 0; }
      backlog = rem; prevAvail = avail;
    }
    var missed = backlog > 1e-9;
    if (missed) spotCost += backlog * pOd;
    return { cost: fixed + spotCost, missed: missed, interruptions: interruptions, lostHours: lostTotal, spotHours: spotHours };
  }

  function percentile(sortedVals, p) {
    var n = sortedVals.length;
    if (n === 1) return sortedVals[0];
    var rank = p * (n - 1), lo = Math.floor(rank), hi = Math.min(lo + 1, n - 1), frac = rank - lo;
    return sortedVals[lo] * (1 - frac) + sortedVals[hi] * frac;
  }
  function summarize(costs, missedFlags, budget) {
    var s = costs.slice().sort(function (a, b) { return a - b; });
    var p95 = percentile(s, 0.95), worst = s.filter(function (c) { return c >= p95; });
    var es = 0; worst.forEach(function (c) { es += c; }); es /= worst.length;
    var over = null;
    if (budget !== null && budget !== undefined) {
      over = s.filter(function (c) { return c > budget; }).length / s.length;
    }
    var miss = 0; missedFlags.forEach(function (m) { if (m) miss++; });
    var mean = 0; s.forEach(function (c) { mean += c; }); mean /= s.length;
    return { median: percentile(s, 0.5), p5: percentile(s, 0.05), p25: percentile(s, 0.25),
             p75: percentile(s, 0.75), p95: p95, es95: es, mean: mean,
             pMiss: miss / missedFlags.length, pOver: over };
  }

  function recommend(stats, budget) {
    var byId = {};
    STRATEGIES.forEach(function (s) { byId[s.id] = stats[s.id]; });
    var cheapestSafe = Math.min(byId.reserved.median, byId.ondemand.median);
    if (budget !== null && budget !== undefined && cheapestSafe > budget) {
      return { id: byId.reserved.median <= byId.ondemand.median ? "reserved" : "ondemand",
               cls: "v-bad", reason: "budget-infeasible" };
    }
    var feasible = STRATEGIES.filter(function (s) { return byId[s.id].pMiss <= MISS_OK; });
    if (feasible.length) {
      var pool = feasible;
      if (budget !== null && budget !== undefined) {
        var calm = feasible.filter(function (s) { return (byId[s.id].pOver || 0) <= OVER_OK; });
        if (calm.length) pool = calm;
      }
      var win = pool[0];
      pool.forEach(function (s) {
        var a = byId[s.id], b = byId[win.id];
        if (a.median < b.median || (a.median === b.median && (a.pOver || 0) < (b.pOver || 0))) win = s;
      });
      var w = byId[win.id];
      var cheapest = Math.min.apply(null, STRATEGIES.map(function (s) { return byId[s.id].median; }));
      if ((win.id === "reserved" || win.id === "ondemand") && w.median <= cheapest * 1.02)
        return { id: win.id, cls: "v-accent", reason: "sure-thing" };
      if (w.pMiss > WARN_MISS || (w.pOver || 0) > OVER_OK)
        return { id: win.id, cls: "v-warn", reason: "risky-winner" };
      return { id: win.id, cls: "v-good", reason: "clean" };
    }
    var win2 = STRATEGIES[0];
    STRATEGIES.forEach(function (s) {
      var a = byId[s.id], b = byId[win2.id];
      if (a.pMiss < b.pMiss || (a.pMiss === b.pMiss && a.median < b.median)) win2 = s;
    });
    return { id: win2.id, cls: "v-warn", reason: "nothing-feasible" };
  }

  function plan(spot, hours, weeks, budget, ckptHours, pRes, pOd, opts) {
    opts = opts || {};
    var cap = opts.cap != null ? opts.cap : pOd;
    var pathsN = opts.paths || 400, seed = opts.seed || 42, block = opts.block || 28;
    var days = Math.round(weeks) * 7;
    var paths = samplePaths(spot, days, pathsN, seed, block);
    var stats = {}, detail = {};
    STRATEGIES.forEach(function (strat) {
      var costs = [], misses = [], ints = 0, lost = 0;
      paths.forEach(function (path) {
        var r = runStrategy(path, strat, hours, pRes, pOd, cap, ckptHours);
        costs.push(r.cost); misses.push(r.missed); ints += r.interruptions; lost += r.lostHours;
      });
      stats[strat.id] = summarize(costs, misses, budget);
      detail[strat.id] = { interruptions: ints / paths.length, lostHours: lost / paths.length };
    });
    var rec = recommend(stats, budget);
    var fan = { p5: [], p50: [], p95: [] };
    for (var t = 0; t < days; t++) {
      var col = paths.map(function (p) { return p[t]; }).sort(function (a, b) { return a - b; });
      fan.p5.push(percentile(col, 0.05)); fan.p50.push(percentile(col, 0.5)); fan.p95.push(percentile(col, 0.95));
    }
    var spotStrat = STRATEGIES.filter(function (s) { return s.id === "spot"; })[0];
    var iid = iidPaths(spot, days, pathsN, seed);
    var iidCosts = iid.map(function (p) { return runStrategy(p, spotStrat, hours, pRes, pOd, cap, ckptHours).cost; })
      .sort(function (a, b) { return a - b; });
    return {
      days: days,
      strategies: STRATEGIES.map(function (strat) {
        var o = { id: strat.id, name: strat.name, short: strat.short };
        Object.keys(stats[strat.id]).forEach(function (k) { o[k] = stats[strat.id][k]; });
        o.interruptions = detail[strat.id].interruptions; o.lostHours = detail[strat.id].lostHours;
        return o;
      }),
      recommendation: rec,
      fan: fan,
      iidSpotMedian: percentile(iidCosts, 0.5),
      blockSpotMedian: stats.spot.median
    };
  }

  var api = { STRATEGIES: STRATEGIES, mulberry32: mulberry32, logReturns: logReturns,
              startPrice: startPrice, samplePaths: samplePaths, iidPaths: iidPaths, runStrategy: runStrategy,
              percentile: percentile, summarize: summarize, recommend: recommend, plan: plan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.GpuPlan = api;
})(typeof window !== "undefined" ? window : globalThis);
