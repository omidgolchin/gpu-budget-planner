/* GPU Budget Planner: page logic. Engine in gpuplan.js, price data in
 * data/prices.js (window.GPU_PRICES), shared helpers in tool-common.js. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  /* Live regions (the verdict title) are written only when their text
   * changes, so a screen reader does not announce an unchanged verdict
   * again after every pause in typing. */
  var setLive = function (el, s) { s = String(s); if (el.textContent !== s) el.textContent = s; };
  function openDetails(id) { var d = document.getElementById(id); if (d && d.tagName === "DETAILS") { d.open = true; d.scrollIntoView({ block: "start" }); var su = d.querySelector("summary"); if (su) su.focus(); } }
  document.querySelectorAll("a.open-details").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); openDetails(a.getAttribute("href").slice(1)); }); });
  if (location.hash === "#fit" || location.hash === "#origin") openDetails(location.hash.slice(1));
  var F = Tool.fmt;
  var DATA = window.GPU_PRICES || null;
  var DEFAULTS = {
    gpu: "h100", hours: 2000, weeks: 6, budget: 9000, ckpt: "2", term: "1", reclaim: "0.142857", after: "idle",
    onDemand: "", reserved: "", cap: "", block: "28", paths: "400"
  };
  /* Common situations. Job sizes are illustrative; prices come from the data. To add one, append
     {label, why, v} with the job fields to set. */
  var EXAMPLES = [
    { label: "Ablation runs: 2,000 H100-hours in 6 weeks", why: "A modest job with weeks of slack. Spot with an on-demand fallback in the last week costs about half of reserving.", v: { gpu: "h100", hours: 2000, weeks: 6, budget: 9000, ckpt: "2", term: "1" } },
    { label: "Workshop deadline: 5,000 A100-hours in 2 weeks", why: "A hard deadline two weeks out. The fallback week covers the risk; a reservation would leave over half its paid hours idle after the job.", v: { gpu: "a100", hours: 5000, weeks: 2, budget: "", ckpt: "4", term: "1" } },
    { label: "Tight budget: 4,000 H100-hours, $10,000", why: "The budget is below the cheapest plan that always finishes on time. The verdict says so instead of recommending a gamble.", v: { gpu: "h100", hours: 4000, weeks: 8, budget: 10000, ckpt: "2", term: "1" } },
    { label: "Patient V100 retrain: 800 hours, 12 weeks", why: "A small, patient job on an older GPU: spot and a short reservation land close.", v: { gpu: "v100", hours: 800, weeks: 12, budget: "", ckpt: "2", term: "3" } },
    { label: "V100 on a 2-year reservation quote", why: "A 2-year reservation for a 12-week job: almost all the paid hours sit idle after the job, so the quote's low hourly price is misleading.", v: { gpu: "v100", hours: 800, weeks: 12, budget: "", ckpt: "2", term: "24" } },
    { label: "Same quote, GPUs reused after the job", why: "The same quote when the reserved GPUs go on to other work: only this job's hours count, and reserving becomes the cheapest plan.", v: { gpu: "v100", hours: 800, weeks: 12, budget: "", ckpt: "2", term: "24", after: "reuse" } },
    { label: "Big pretrain: 8,000 H100-hours, 12 weeks", why: "A larger job with a budget and a 3-month reservation option.", v: { gpu: "h100", hours: 8000, weeks: 12, budget: 30000, ckpt: "4", term: "3" } },
    { label: "Lockstep pretrain: 60,000 H100-hours in 4 weeks", why: "A big fleet that stops whenever any node is reclaimed (about once a day per node), with 8-hour checkpoints. Spot loses so much work that it cannot finish on time; reserving wins.", v: { gpu: "h100", hours: 60000, weeks: 4, budget: 220000, ckpt: "8", term: "1", reclaim: "1" } }
  ];
  var IDS = ["gpu", "hours", "weeks", "budget", "ckpt", "term", "after", "reclaim", "onDemand", "reserved", "cap", "block", "paths"];
  var TITLES = {
    reserved: "Reserve everything now",
    ondemand: "Pay on demand for everything",
    spot: "Run it all on spot",
    spotfb: "Run it all on spot, with an on-demand fallback in the last week",
    mix25: "Reserve 25% now, run the rest on spot",
    mix50: "Reserve 50% now, run the rest on spot",
    mix60: "Reserve 60% now, run the rest on spot",
    mix75: "Reserve 75% now, run the rest on spot"
  };
  var state = Tool.readParams(DEFAULTS);
  var last = null;

  function setInputs(v) { Object.keys(v).forEach(function (k) { var e = $(k); if (e) e.value = v[k] === null ? "" : v[k]; }); }
  function num(id) { var v = $(id).value; return v === "" ? null : Number(v); }
  function price(v) { return "$" + Number(v).toFixed(2); }
  function shortMoney(v) { return v >= 1000 ? "$" + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : "$" + Math.round(v); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function fieldError(id, msg) {
    var f = $(id).closest(".field"); if (!f) return; var e = f.querySelector(".err");
    f.classList.toggle("invalid", !!msg);
    if (msg) { if (!e) { e = document.createElement("div"); e.className = "err"; f.appendChild(e); } e.textContent = msg; }
    else if (e) e.remove();
  }
  function gpuData() { return DATA.gpus[$("gpu").value] || DATA.gpus.h100; }
  function updateGpuHint() {
    if (!DATA) return;
    var g = gpuData();
    $("gpuHint").textContent = "Spot history: AWS " + g.instance + " (" + g.gpusPerInstance + " × " + g.label + " per instance), us-east-1, May to November 2024.";
  }
  function reservedPrefill(g, term) {
    if (g.reservedByTerm[term] != null) return g.reservedByTerm[term];
    var terms = Object.keys(g.reservedByTerm).map(Number).sort(function (a, b) { return a - b; });
    var best = terms[0]; terms.forEach(function (t) { if (Math.abs(t - term) < Math.abs(best - term)) best = t; });
    return g.reservedByTerm[best];
  }
  function fillPrices(force) {
    if (!DATA) return;
    var g = gpuData();
    if (force || $("onDemand").value === "") $("onDemand").value = g.onDemand;
    if (force || $("reserved").value === "") $("reserved").value = reservedPrefill(g, Number($("term").value));
  }
  function fmtDate(iso) {
    var M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    var p = iso.split("-"); return M[Number(p[1]) - 1] + " " + Number(p[2]) + ", " + p[0];
  }

  setInputs(state);
  if (DATA) {
    fillPrices(false);
    updateGpuHint();
    $("odHint").textContent = "Prefilled from GetDeploying's weekly medians (week of " + fmtDate(DATA.gdWeek) + "). Edit if your quote differs.";
    $("resHint").textContent = "Prefilled: median listing for the term above, same week. Changing the GPU or term refills both prices.";
    $("gdWeek").textContent = fmtDate(DATA.gdWeek);
  }
  var q0 = new URLSearchParams(location.search);
  if (!IDS.some(function (k) { return q0.has(k); })) Tool.exampleWatch($("f-job"), "<b>" + EXAMPLES[0].label + "</b>, with the prefilled median prices. Type your own job over it; the plan updates as you type.");
  EXAMPLES.forEach(function (ex, i) { var o = document.createElement("option"); o.value = i; o.textContent = ex.label; $("example").appendChild(o); });
  $("example").addEventListener("change", function () {
    if (this.value === "") return;
    var ex = EXAMPLES[+this.value], v = ex.v; this.value = "";
    Tool.exampleWatch($("f-job"), "<b>" + ex.label + ".</b> " + (ex.why || "") + " Type your own job over it; the plan updates as you type.");
    document.querySelectorAll(".field.filled").forEach(function (f) { f.classList.remove("filled"); });
    $("gpu").value = v.gpu; $("term").value = v.term; fillPrices(true);
    $("hours").value = v.hours; $("weeks").value = v.weeks; $("budget").value = v.budget; $("ckpt").value = v.ckpt;
    $("reclaim").value = v.reclaim || DEFAULTS.reclaim; $("after").value = v.after || DEFAULTS.after;
    run();
  });
  IDS.forEach(function (id) {
    $(id).addEventListener("input", debounce(run, 250));
    $(id).addEventListener("change", function () {
      if (id === "gpu") { fillPrices(true); updateGpuHint(); }
      if (id === "term") fillPrices(true);
      run();
    });
  });
  window.addEventListener("resize", debounce(function () { if (last) drawCharts(); }, 200));
  if (window.KitTheme) KitTheme.onChange(function () { setTimeout(function () { if (last) drawCharts(); }, 0); });

  /* ---------- AI assist ---------- */
  if (window.ASSIST_CONFIG) Tool.assist(Object.assign({}, window.ASSIST_CONFIG, {
    mount: $("assistMount"), toggle: $("assistToggle"),
    apply: function (vals) {
      document.querySelectorAll(".field.filled").forEach(function (f) { f.classList.remove("filled"); });
      function mark(id, v) { if (v === undefined || v === null) return; $(id).value = v; var f = $(id).closest(".field"); if (f) f.classList.add("filled"); }
      function snap(v, opts) { var b = opts[0]; opts.forEach(function (o) { if (Math.abs(o - v) < Math.abs(b - v)) b = o; }); return b; }
      if (vals.gpu) {
        var m = /h100|a100|v100/i.exec(String(vals.gpu));
        if (m) { $("gpu").value = m[0].toLowerCase(); fillPrices(true); mark("gpu", $("gpu").value); }
      }
      if (vals.termMonths != null) { $("term").value = snap(Number(vals.termMonths), [1, 3, 6, 12, 24, 36]); fillPrices(true); mark("term", $("term").value); }
      mark("hours", vals.hours); mark("weeks", vals.weeks); mark("budget", vals.budget);
      if (vals.ckptHours != null) mark("ckpt", snap(Number(vals.ckptHours), [0.5, 1, 2, 4, 8, 24, 168]));
      mark("onDemand", vals.onDemand); mark("reserved", vals.reserved);
      run();
    }
  }));

  /* ---------- the plan ---------- */
  function readInputs() {
    var v = {
      gpu: $("gpu").value, hours: num("hours"), weeks: num("weeks"), budget: num("budget"),
      ckpt: Number($("ckpt").value), term: Number($("term").value), reclaim: Number($("reclaim").value), after: $("after").value,
      onDemand: num("onDemand"), reserved: num("reserved"), cap: num("cap"),
      block: Number($("block").value), paths: Number($("paths").value)
    };
    var ok = true;
    function need(id, cond, msg) { fieldError(id, cond ? "" : msg); if (!cond) ok = false; }
    need("hours", v.hours > 0 && v.hours <= 1000000, "Enter the total GPU-hours, from 1 to 1,000,000.");
    need("weeks", v.weeks >= 1 && v.weeks <= 52 && Math.floor(v.weeks) === v.weeks, "A whole number of weeks, 1 to 52.");
    need("budget", v.budget === null || v.budget > 0, "Enter a budget in dollars above 0, or leave it empty for no limit.");
    need("onDemand", v.onDemand === null || (v.onDemand > 0 && v.onDemand <= 1000), "Enter a price per GPU-hour above 0 (up to $1,000), or leave it empty to use the prefilled price.");
    need("reserved", v.reserved === null || (v.reserved > 0 && v.reserved <= 1000), "Enter a price per GPU-hour above 0 (up to $1,000), or leave it empty to use the prefilled price.");
    need("cap", v.cap === null || v.cap > 0, "Above 0, or empty for the on-demand price.");
    return ok ? v : null;
  }

  function run() {
    if (DATA) { fillPrices(false); updateGpuHint(); }
    var urlState = {}; IDS.forEach(function (k) { urlState[k] = $(k).value; }); Tool.writeParams(urlState);
    if (!DATA) { setLive($("vTitle"), "Price data did not load."); return; }
    var v = readInputs();
    if (!v) {
      setLive($("vTitle"), "Check the highlighted inputs"); $("vBody").textContent = "";
      $("kpis").innerHTML = ""; $("checks").innerHTML = "";
      $("verdict").className = "panel verdict v-neutral";
      $("boxChart").innerHTML = ""; $("boxCaption").textContent = ""; last = null; return;
    }
    var g = gpuData();
    var pOd = num("onDemand"), pRes = num("reserved");
    var cap = v.cap === null ? pOd : v.cap;
    var opt = { cap: cap, paths: v.paths, block: v.block, seed: 42, reclaim: v.reclaim / 24, gpn: 8,
      termHours: v.after === "idle" ? v.term * 730 : null };
    var out = GpuPlan.plan(g.spot, v.hours, v.weeks, v.budget, v.ckpt, pRes, pOd, opt);
    var out1 = null;
    if (v.ckpt !== 1) out1 = GpuPlan.plan(g.spot, v.hours, v.weeks, v.budget, 1, pRes, pOd, opt);
    var sens = GpuPlan.priceSensitivity(g.spot, v.hours, v.weeks, v.budget, v.ckpt, pRes, pOd, opt);
    last = { v: v, g: g, out: out, out1: out1, sens: sens, pOd: pOd, pRes: pRes, cap: cap };
    render();
  }

  /* What a reservation commits to, when its GPUs sit idle after the job. */
  function commitNote() {
    var v = last.v; if (v.after !== "idle") return "";
    var days = v.weeks * 7, gpus = Math.ceil(v.hours / (days * 24) - 1e-9);
    var terms = Math.ceil(days * 24 / (v.term * 730) - 1e-9), paidH = gpus * terms * v.term * 730;
    var idle = paidH - v.hours;
    return idle > 0.05 * paidH ? " (" + gpus + " GPU" + (gpus > 1 ? "s" : "") + " for " + (terms * v.term) + " month" + (terms * v.term > 1 ? "s" : "") +
      ", " + F.pct(idle / paidH, 0) + " of the paid hours idle after the job)" : "";
  }
  function byId(out) { var m = {}; out.strategies.forEach(function (s) { m[s.id] = s; }); return m; }
  function stratName(out, id) { return out.strategies.filter(function (s) { return s.id === id; })[0].name; }

  function render() {
    var v = last.v, out = last.out, S = byId(out), rec = out.recommendation, W = S[rec.id];
    var spot = S.spot, res = S.reserved, od = S.ondemand;
    var title, body;
    if (rec.reason === "budget-infeasible") {
      title = "That budget cannot be met";
      body = "The cheapest plan that always finishes on time is " + stratName(out, rec.id).toLowerCase() +
        " at a fixed " + F.money(W.median) + ", already over your " + F.money(v.budget) + " budget. " +
        "Spot plans can come in under it (all-spot's median is " + F.money(spot.median) + "), but they are gambles, not plans. " +
        "Raise the budget to about " + F.money(W.median) + ", or cut the GPU-hours.";
    } else {
      title = TITLES[rec.id];
      body = "Median bill " + F.money(W.median) + "; the middle 90% of simulated bills run " +
        F.money(W.p5) + " to " + F.money(W.p95) + ".";
      if (v.budget !== null) body += " Chance of going over your " + F.money(v.budget) + " budget: " + F.pct(W.pOver, 0) + ".";
      if (rec.id === "spot" || rec.id === "spotfb") {
        body += " Reserving everything would cost " + F.money(res.median) + " for certain, " +
          F.money(res.median - W.median) + " more than this plan's median" + commitNote() + ".";
      } else if (rec.id === "reserved" || rec.id === "ondemand") {
        body += " All-spot's median is " + F.money(spot.median) + ", " +
          F.money(Math.abs(spot.median - W.median)) + (spot.median < W.median ? " less" : " more") +
          ", and it finishes late in " + F.pct(spot.pMiss, 0) + " of runs. The sure thing wins.";
      } else {
        body += " All-spot's median is " + F.money(spot.median) + " but it finishes late in " + F.pct(spot.pMiss, 0) +
          " of runs; reserving everything costs " + F.money(res.median) + " for certain" + commitNote() + ".";
      }
      if (W.pMiss > 0) body += " This plan itself finishes late in " + F.pct(W.pMiss, 0) + " of runs.";
    }
    body += " Reservations are priced " + (v.after === "reuse" ? "on this job's hours only, because you said the reserved GPUs go to other work after the deadline." : "for every hour of the " + v.term + "-month term, because you said the reserved GPUs sit idle after the deadline.");
    setLive($("vTitle"), title); $("vBody").textContent = body;
    $("verdict").className = "panel verdict " + rec.cls;
    last.title = title; last.body = body;

    /* The dashboard tiles ARE the verdict: median bill, plausible range,
     * chance over budget, chance of finishing late — all read off the
     * winning plan's row (W). The expected shortfall and interruption
     * count that used to sit here stay in the checks and Full numbers. */
    var k = [
      [F.money(W.median), "median bill", "median", ""],
      [F.money(W.p5) + " – " + F.money(W.p95), "plausible range · middle 90% of bills", "range", " range"],
      v.budget !== null
        ? [F.pct(W.pOver, 0), "chance over budget", "budget", ""]
        : ["—", "chance over budget · no budget set", "budget", ""],
      [F.pct(W.pMiss, 0), "chance of finishing late", "late", ""]
    ];
    $("kpis").innerHTML = k.map(function (x) { return '<div class="kpi-tile"><span class="k-val' + x[3] + '">' + x[0] + '</span><span class="k-lbl">' + x[1] + ' <button type="button" data-tip="' + x[2] + '"></button>' + "</span></div>"; }).join("");

    var c = [];
    /* Deadline risk: a plan no pricier than the winner that is often late. */
    var traps = out.strategies.filter(function (s) { return s.id !== rec.id && s.median <= W.median * 1.005 && s.pMiss > 0.05; });
    if (traps.length) {
      var t0 = traps.reduce(function (a, b) { return a.median < b.median ? a : b; });
      c.push(["fail", "LATE RISK", "Deadline", t0.name + " matches or beats the recommended plan's median (" + F.money(t0.median) +
        ") but finishes late in " + F.pct(t0.pMiss, 0) + " of simulated runs. The recommendation is buying the deadline, not a lower median."]);
    } else if (W.pMiss > 0.02) {
      c.push(["warn", "DEADLINE", "Deadline", "The recommended plan itself finishes late in " + F.pct(W.pMiss, 0) +
        " of runs. If the deadline is hard, add the on-demand fallback or reserve more."]);
    } else {
      c.push(["ok", "ON TIME", "Deadline", "No plan at or below the recommended plan's median finishes late in more than 5% of runs; no cheap-but-late trap here."]);
    }
    /* Tail risk: expected shortfall beside the percentile. */
    var tailTxt = "The 95th percentile bill for the recommended plan is " + F.money(W.p95) +
      "; the average of the worst 5% of bills (the expected shortfall, Acerbi & Tasche 2002) is " + F.money(W.es95) +
      ", " + F.pct((W.es95 - W.p95) / W.p95, 1) + " higher. Budget against the shortfall, not the percentile.";
    c.push([v.budget !== null && W.es95 > v.budget ? "warn" : "info", "BAD CASE", "Expected shortfall", tailTxt]);
    /* Budget. */
    if (rec.reason === "budget-infeasible") {
      c.push(["fail", "OVER BUDGET", "Budget", "No fixed-price plan fits " + F.money(v.budget) +
        ": all reserved costs " + F.money(res.median) + " and all on-demand " + F.money(od.median) + ", whatever the spot price does."]);
    } else if (v.budget !== null) {
      c.push([W.pOver <= 0.05 ? "ok" : W.pOver <= 0.2 ? "info" : "warn", "BUDGET", "Budget",
        "The recommended plan goes over " + F.money(v.budget) + " in " + F.pct(W.pOver, 0) + " of simulated runs."]);
    }
    /* Spot price move: does the winner survive the spot level ±20%? */
    var sd = last.sens.down, su = last.sens.up;
    if (sd.id === rec.id && su.id === rec.id) {
      c.push(["ok", "PRICE HOLDS", "Spot price move", "This recommendation does not depend on today's spot level: " +
        "the same plan wins with spot prices 20% lower (median " + F.money(sd.median) + ") " +
        "and with spot prices 20% higher (median " + F.money(su.median) + ")."]);
    } else {
      var flips = [];
      if (sd.id !== rec.id) flips.push("spot prices 20% lower would make " + stratName(out, sd.id).toLowerCase() + " the winner (median " + F.money(sd.median) + ")");
      if (su.id !== rec.id) flips.push("spot prices 20% higher would make " + stratName(out, su.id).toLowerCase() + " the winner (median " + F.money(su.median) + ")");
      var sharePct = Math.round(GpuPlan.spotMoveShare(last.g.spot) * 100);
      c.push(["warn", "PRICE MOVE", "Spot price move", "This recommendation is priced off today's spot level, and the answer is close: " +
        flips.join("; ") + ". In the spot data for this GPU, " + sharePct + "% of 30-day periods moved by 20% or more, so check a fresh spot quote before you commit."]);
    }
    /* Checkpoints and reclaims, against the hourly-checkpoint counterfactual. */
    var gpus = v.hours / (v.weeks * 7 * 24), nodes = gpus / 8;
    var fleet = "Your job keeps about " + (gpus >= 10 ? F.int(gpus) : F.num(gpus, 1)) + " GPUs busy (" +
      (nodes < 1 ? "part of one 8-GPU node" : (nodes >= 10 ? F.int(nodes) : F.num(nodes, 1)) + " nodes of 8") + "). ";
    var reclaimTxt = $("reclaim").selectedOptions[0].textContent.replace(/\s*\(.*?\)\s*/g, "").toLowerCase();
    var guessTxt = $("reclaim").value === DEFAULTS.reclaim ? " That reclaim rate is the tool's default guess, not a measurement: try once a day too and see whether the recommendation changes." : "";
    var lostW = W.lostHours, intsW = W.interruptions;
    var redone = intsW >= 0.05 ? " The recommended plan sees about " + F.num(intsW, intsW >= 10 ? 0 : 1) + " interruptions per run and redoes about " +
      F.int(lostW) + (Math.round(lostW) === 1 ? " GPU-hour" : " GPU-hours") + (lostW > 0 ? " (" + F.pct(lostW / v.hours, lostW / v.hours < 0.01 ? 1 : 0) + " of the job)" : "") + "." : "";
    if (last.out1 && last.out1.recommendation.id !== rec.id) {
      var W1 = byId(last.out1)[last.out1.recommendation.id];
      c.push(["warn", "CHECKPOINTS", "Checkpoint interval", fleet + "A job that runs its nodes in lockstep <button type=\"button\" data-tip=\"lockstep\"></button> stops whenever any one is reclaimed, and loses half a checkpoint interval of everyone's work." + redone +
        " With hourly checkpoints the winner would be " + stratName(last.out1, last.out1.recommendation.id).toLowerCase() + " (median " + F.money(W1.median) + "): checkpoint more often if you can."]);
    } else if (last.out1 && Math.abs(byId(last.out1)[rec.id].median - W.median) > 0.02 * W.median) {
      c.push(["info", "CHECKPOINTS", "Checkpoint interval", fleet + "A lockstep <button type=\"button\" data-tip=\"lockstep\"></button> job stops whenever any node is reclaimed." + redone +
        " Hourly checkpoints would put this plan's median at " + F.money(byId(last.out1)[rec.id].median) + " instead of " + F.money(W.median) + "."]);
    } else if (v.reclaim > 0) {
      c.push(["ok", "CHECKPOINTS", "Checkpoint interval", fleet + "With nodes reclaimed " + reclaimTxt + ", a job this size loses little to interruptions at " + v.ckpt + "-hour checkpoints." + redone +
        " The interval starts to matter as the fleet grows: every extra node is another way for the whole job to stop." + guessTxt]);
    } else {
      c.push(["info", "CHECKPOINTS", "Checkpoint interval", "Only price-cap interruptions are modeled, and spot prices rarely reach your cap. Spot nodes are reclaimed for capacity whatever the price, so set how often that happens to price it in."]);
    }
    /* Forecast coverage for this GPU's series. */
    var cov = last.g.coverage, covPct = cov.pct;
    if (covPct >= 0.78 && covPct <= 0.97) {
      c.push(["ok", "CHECKED", "Forecast intervals", "Backtest on the held-out months (" + cov.months.join(", ") +
        "): the simulated 90% price band contained the real price on " + F.pct(covPct, 0) + " of " + cov.days + " days. The ranges above are honest for this GPU."]);
    } else {
      c.push(["warn", "CHECK", "Forecast intervals", "Backtest on the held-out months (" + cov.months.join(", ") +
        "): the simulated 90% price band contained the real price on only " + F.pct(covPct, 0) + " of " + cov.days +
        " days. Prices trended out of the band, so treat the ranges above as optimistic for this GPU."]);
    }
    $("checks").innerHTML = c.map(function (x) { return '<div class="check is-' + x[0] + '"><span class="badge">' + x[1] + '</span><div><span class="c-name">' + x[2] + '.</span> <span class="c-text">' + x[3] + "</span></div></div>"; }).join("");
    last.checks = c;
    drawCharts();
    drawTable();
  }

  /* ---------- charts and table ---------- */
  function cssVar(name, fallback) {
    var val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  }
  function drawCharts() { drawBox(); drawFan(); }
  function drawBox() {
    var host = $("boxChart"); if (!last) { host.innerHTML = ""; return; }
    var out = last.out, W = Math.max(280, host.clientWidth || 600);
    var NS = "http://www.w3.org/2000/svg";
    function el(name, attrs, parent) { var e = document.createElementNS(NS, name); Object.keys(attrs || {}).forEach(function (k2) { e.setAttribute(k2, attrs[k2]); }); if (parent) parent.appendChild(e); return e; }
    var narrow = W < 480, labelW = narrow ? 92 : 132, right = 58, plotW = W - labelW - right;
    var top = 24, rowH = 36, H = top + out.strategies.length * rowH + 6;
    var xMax = 0;
    out.strategies.forEach(function (s) { xMax = Math.max(xMax, s.es95); });
    if (last.v.budget !== null) xMax = Math.max(xMax, last.v.budget);
    xMax *= 1.03;
    var X = function (x) { return labelW + (x / xMax) * plotW; };
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Cost distribution per plan" }, host);
    host.innerHTML = ""; host.appendChild(svg);
    var ticks = Tool.niceTicks(0, xMax, narrow ? 3 : 5);
    ticks.forEach(function (t) {
      el("line", { x1: X(t), x2: X(t), y1: top - 6, y2: H - 4, stroke: cssVar("--grid", "#ddd"), "stroke-width": 1 }, svg);
      var tx = el("text", { x: X(t), y: 12, "text-anchor": "middle", class: "boxaxis" }, svg); tx.textContent = shortMoney(t);
    });
    if (last.v.budget !== null) {
      el("line", { x1: X(last.v.budget), x2: X(last.v.budget), y1: top - 6, y2: H - 4, stroke: cssVar("--bad", "#b3261e"), "stroke-width": 1.4, "stroke-dasharray": "5 4" }, svg);
      var bt = el("text", { x: X(last.v.budget), y: top - 10, "text-anchor": "middle", class: "boxaxis" }, svg); bt.textContent = "budget";
    }
    out.strategies.forEach(function (s, i) {
      var y = top + i * rowH + rowH / 2, win = s.id === out.recommendation.id;
      var lab = el("text", { x: 0, y: y + 4, class: "boxrow-label" + (win ? " win" : "") }, svg);
      lab.textContent = narrow ? s.short : s.name.replace(", on-demand fallback in the last week", " + fallback");
      el("line", { x1: X(s.p5), x2: X(s.p95), y1: y, y2: y, stroke: cssVar("--neutral", "#888"), "stroke-width": 2 }, svg);
      el("line", { x1: X(s.p5), x2: X(s.p5), y1: y - 6, y2: y + 6, stroke: cssVar("--neutral", "#888"), "stroke-width": 2 }, svg);
      el("line", { x1: X(s.p95), x2: X(s.p95), y1: y - 6, y2: y + 6, stroke: cssVar("--neutral", "#888"), "stroke-width": 2 }, svg);
      el("rect", { x: X(s.p25), y: y - 7, width: Math.max(2, X(s.p75) - X(s.p25)), height: 14, fill: win ? cssVar("--accent", "#0b5fa5") : cssVar("--neutral", "#888"), opacity: win ? 1 : 0.5, rx: 2 }, svg);
      el("line", { x1: X(s.median), x2: X(s.median), y1: y - 8, y2: y + 8, stroke: cssVar("--card", "#fff"), "stroke-width": 2 }, svg);
      var d = el("path", { d: "M" + X(s.es95) + " " + (y - 6) + " L" + (X(s.es95) + 6) + " " + y + " L" + X(s.es95) + " " + (y + 6) + " L" + (X(s.es95) - 6) + " " + y + " Z", fill: cssVar("--series-2", "#b26a00") }, svg);
      if (s.pMiss > 0.05) {
        var lt = el("text", { x: X(s.p95) + 10, y: y + 4, class: "boxlate" }, svg);
        lt.textContent = "late " + F.pct(s.pMiss, 0);
      }
    });
    $("boxCaption").textContent = "How to read it: each row is one plan. The box holds the middle 50% of simulated bills, the white line is the median, the whiskers run from the 5th to the 95th percentile, and the diamond is not a percentile: it is the expected shortfall, the average of the worst 5% of bills. A plan with a low box but a far-right diamond is cheap on average and painful in a bad month. " +
      "All plans are scored on the same " + last.v.paths + " simulated price paths. Rows marked late miss the deadline in more than 5% of runs.";
  }
  function drawFan() {
    var host = $("fanChart"); if (!last) { host.innerHTML = ""; return; }
    var g = last.g, out = last.out, spot = g.spot, n = spot.length, days = out.days;
    var hist = [];
    for (var i = Math.max(0, n - 60); i < n; i++) hist.push([i - (n - 1), spot[i]]);
    var med = [], lo = [], hi = [];
    for (var t = 0; t < days; t++) { med.push([t, out.fan.p50[t]]); lo.push([t, out.fan.p5[t]]); hi.push([t, out.fan.p95[t]]); }
    Tool.lineChart(host, {
      series: [
        { label: "Spot price, recent history", color: "neutral", points: hist },
        { label: "Simulated median", color: "accent", points: med },
        { label: "Middle 90% of paths", color: "neutral", points: hi, dash: "5 4" },
        { label: "", color: "neutral", points: lo, dash: "5 4" }
      ],
      legend: true, height: 260,
      hLines: [{ y: last.cap, label: "your cap " + price(last.cap), color: "series2", labelLeft: true }],
      xTitle: "days from today", yTitle: "$ per GPU-hour",
      xFormat: function (x) { return x === 0 ? "today" : (x < 0 ? x + "d" : "+" + x + "d"); },
      yFormat: function (y) { return "$" + y.toFixed(2); }
    });
    $("fanCaption").textContent = "Left of today: the last 60 days of the " + g.label + " spot series the simulation resamples (AWS us-east-1 changes, level set to today's market). Right: the simulated band for your deadline. Paths start at " +
      price(GpuPlan.startPrice(spot)) + ", the median of the last 30 observed days.";
    var cov = g.coverage;
    $("coverageNote").textContent = "Coverage backtest for " + g.label + ": simulating each held-out month (" + cov.months.join(" and ") +
      ") from the data available before it, the 90% band contained the real price on " + cov.covered + " of " + cov.days + " days (" + F.pct(cov.pct, 0) + ").";
  }
  function drawTable() {
    if (!last) return;
    var out = last.out, v = last.v;
    $("fullTable").innerHTML = "<thead><tr><th>Plan</th><th class=\"num\">Median</th><th class=\"num\">5–95% range</th><th class=\"num\">Worst-5% average</th><th class=\"num\">Finishes late</th>" +
      (v.budget !== null ? "<th class=\"num\">Over budget</th>" : "") +
      "<th class=\"num\">Interruptions</th><th class=\"num\">Work redone</th></tr></thead><tbody>" +
      out.strategies.map(function (s) {
        return "<tr" + (s.id === out.recommendation.id ? " class=\"win\"" : "") + "><td>" + s.name + "</td><td class=\"num\">" + F.money(s.median) +
          "</td><td class=\"num\">" + F.money(s.p5) + " – " + F.money(s.p95) + "</td><td class=\"num\">" + F.money(s.es95) +
          "</td><td class=\"num\">" + F.pct(s.pMiss, 0) + "</td>" +
          (v.budget !== null ? "<td class=\"num\">" + F.pct(s.pOver, 0) + "</td>" : "") +
          "<td class=\"num\">" + s.interruptions.toFixed(1) + "</td><td class=\"num\">" + F.int(s.lostHours) + " h</td></tr>";
      }).join("") + "</tbody>";
    $("iidNote").textContent = "Why blocks, not days: resampling the price changes one day at a time (the naive i.i.d. way) puts the all-spot median at " +
      F.money(out.iidSpotMedian) + " instead of " + F.money(out.blockSpotMedian) +
      ". Shuffling single days breaks up the multi-day price runs that cause interruptions and deadline misses, so it misprices exactly the risk this tool exists to show.";
  }

  $("copyLink").addEventListener("click", function () { Tool.copy(location.href, $("toast"), "Link copied: it opens with these inputs."); });
  $("copySummary").addEventListener("click", function () {
    if (!last) return; var v = last.v;
    var ckLabel = $("ckpt").selectedOptions[0].textContent;
    Tool.copy(["GPU plan: " + last.title, last.body, "",
      "Inputs: " + F.int(v.hours) + " " + last.g.label + " GPU-hours in " + v.weeks + " weeks, checkpoints " + ckLabel.toLowerCase() +
      ", on-demand " + price(last.pOd) + "/GPU-hour, reserved " + price(last.pRes) + " (" + v.term + "-month term)" +
      (v.budget !== null ? ", budget " + F.money(v.budget) : "") + ".",
      "Open with these inputs: " + location.href].join("\n"), $("toast"), "Summary copied.");
  });

  Tool.explain({
    ckpt: { t: "Checkpoints", d: "A checkpoint saves the training state so a stopped job can resume. Spot GPUs can be taken back at short notice; everything since the last checkpoint is lost and redone. Frequent checkpoints make spot cheaper in practice." },
    term: { t: "Reservation term", d: "Reserved capacity is bought for a fixed term at a discount. You pay for every hour of the term, used or not, so a long term only pays off if the GPUs stay busy." },
    after: { t: "Reserved GPUs after the deadline", d: "If the reservation outlasts the job, the remaining hours are either wasted (you still pay) or used by other work. Only count them as used if your team will really use them." },
    reclaim: { t: "Spot reclaims", d: "How often the provider takes spot capacity back. Each reclaim costs the work since the last checkpoint plus restart time. The simulation draws reclaims at random at this rate (a Poisson process) for each node. The default, once a week per node, is a guess for when you have no logs: run once a day as well, and if the recommendation changes, the rate matters for your job. AWS's Spot Instance Advisor gives a past-month interruption band per instance type and region; your own logs beat any guess." },
    paths: { t: "Simulated price paths", d: "Future spot prices are unknown, so the tool builds many plausible price paths by resampling blocks of real price history (a block bootstrap) and prices every plan on each one." },
    lockstep: { t: "Lockstep training", d: "Distributed training where every node advances together, step by step. If one node is taken away, the whole job stops and resumes from the last checkpoint, so one reclaim costs everyone's work since then, not just that node's." },
    block: { t: "Bootstrap block length", d: "The simulation builds future spot prices by stitching together random stretches of real price history. This sets how long each stretch is. Longer stretches keep price runs (a week of high prices) intact; 28 days predicted held-out months best." },
    plans: { t: "Reading the plan chart", d: "Each row is a plan. The box covers the middle 50% of simulated bills, the whiskers the 5th to 95th percentile, and the diamond is the expected shortfall: the average of the worst 5% of bills. A plan whose box is low but whose diamond sits far right is cheap on average and risky in a bad month." },
    median: { t: "Median bill", d: "Half the simulated price paths give a lower bill, half a higher one. The typical case, not the worst." },
    range: { t: "Plausible range", d: "The middle 90% of simulated bills for the recommended plan: on 5% of simulated price paths the bill comes in below this range, on 5% above it. The median sits inside it." },
    budget: { t: "Chance over budget", d: "The share of simulated price paths in which the recommended plan's bill goes over the budget you entered. If you enter no budget, there is nothing to go over, and the tile says so." },
    es: { t: "Expected shortfall (worst 5%)", d: "The average bill across the worst 5% of simulated outcomes. Budgeting to this, rather than the 95th percentile alone, accounts for how bad the tail can get (Acerbi and Tasche, 2002)." },
    late: { t: "Chance of finishing late", d: "Share of simulated runs in which interruptions and redone work push the job past the deadline. Plans that miss in more than 5% of runs are not recommended." }
  });

  run();
})();
