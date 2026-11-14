#!/usr/bin/env python3
"""Turn the raw downloads (scripts/download_data.py) into the one file the
page reads: docs/data/prices.json.

Per GPU (AWS instance type, us-east-1):
- daily spot price: for each day and AZ, the last price observed that day;
  the day's price is the median across AZs; divided by the GPUs in the
  instance. Days are forward-filled (a spot price stands until it changes).
- level anchor: the whole series is multiplied by one constant so that its
  last-30-day median equals GetDeploying's current spot median for that
  GPU. The archive's dynamics (daily moves, runs, volatility) are 2024
  AWS data; the level is today's market. Log returns, and therefore every
  simulation and the coverage backtest, are unaffected by the constant.
- prefills: on-demand = GetDeploying's latest provider-median price;
  reserved per term = GetDeploying's latest median listing price for that
  reservation term; both are starting points the visitor can edit.
- coverage: the walk-forward band backtest from src/gpubudget/coverage.py
  on the shipped series (last two calendar months held out).

Also writes results/data_summary.json (the numbers the README and the
review report quote) and results/figures/spot_history.png.
"""

import csv
import json
import statistics as st
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from gpubudget.coverage import band_coverage  # noqa: E402

GPUS = {
    "h100": {"label": "H100", "instance": "p5.48xlarge", "per": 8, "gd": "nvidia-h100"},
    "a100": {"label": "A100", "instance": "p4d.24xlarge", "per": 8, "gd": "nvidia-a100"},
    "v100": {"label": "V100", "instance": "p3.2xlarge", "per": 1, "gd": "nvidia-v100"},
}
REGION_PREFIX = "use1"          # us-east-1 (N. Virginia)
TERMS = [1, 3, 6, 12, 24, 36]


def aws_daily_series(instance):
    """date -> median across AZs of the day's last price per AZ (instance $)."""
    last = {}                   # (day, az) -> (timestamp, price)
    for fn in sorted((ROOT / "data" / "raw" / "aws-spot").glob("filtered-*.tsv")):
        for line in open(fn):
            az, inst, _os, price, ts = line.rstrip("\n").split("\t")
            if inst != instance or not az.startswith(REGION_PREFIX):
                continue
            key = (ts[:10], az)
            if key not in last or ts > last[key][0]:
                last[key] = (ts, float(price))
    by_day = defaultdict(list)
    for (day, _az), (_ts, price) in last.items():
        by_day[day].append(price)
    days = sorted(by_day)
    start = date.fromisoformat(days[0])
    end = date.fromisoformat(days[-1])
    out_days, out_vals = [], []
    prev = None
    d = start
    while d <= end:
        key = d.isoformat()
        if key in by_day:
            prev = st.median(by_day[key])
        out_days.append(key)
        out_vals.append(prev)
        d += timedelta(days=1)
    return out_days, out_vals


def gd_rows(slug):
    fn = ROOT / "data" / "raw" / "getdeploying" / f"{slug}.csv"
    return list(csv.DictReader(open(fn)))


def gd_latest(rows, billing, months=None):
    sel = [r for r in rows if r["billing_type"] == billing
           and (months is None or (r["reservation_months"] or None) == (str(months) if months else None))]
    if not sel:
        return None
    latest = max(r["date"] for r in sel)
    row = next(r for r in sel if r["date"] == latest)
    return row


def main():
    gpus = {}
    summary = {}
    for slug, cfg in GPUS.items():
        days, inst_prices = aws_daily_series(cfg["instance"])
        raw = [p / cfg["per"] for p in inst_prices]
        rows = gd_rows(cfg["gd"])
        od_row = gd_latest(rows, "ON_DEMAND")
        spot_row = gd_latest(rows, "SPOT")
        on_demand = float(od_row["provider_median_price"])
        gd_spot = float(spot_row["provider_median_price"])
        reserved = {}
        for t in TERMS:
            r = gd_latest(rows, "RESERVATION", t)
            if r:
                reserved[str(t)] = round(float(r["median_price"]), 4)
        last30 = st.median(raw[-30:])
        scale = gd_spot / last30
        spot = [round(p * scale, 4) for p in raw]
        cov = band_coverage(days, spot, holdout_months=2, count=200, seed=7, block=28)
        gpus[slug] = {
            "label": cfg["label"],
            "instance": cfg["instance"],
            "gpusPerInstance": cfg["per"],
            "region": "us-east-1",
            "days": days,
            "spot": spot,
            "onDemand": round(on_demand, 4),
            "reservedByTerm": reserved,
            "defaultTerm": 12,
            "coverage": {"covered": cov["covered"], "days": cov["days"],
                         "pct": round(cov["pct"], 4),
                         "months": [m["month"] for m in cov["months"]]},
        }
        rets = [abs(spot[i + 1] / spot[i] - 1) for i in range(len(spot) - 1)]
        summary[slug] = {
            "days": len(days), "from": days[0], "to": days[-1],
            "raw_median_per_gpu": round(st.median(raw), 4),
            "raw_last30_median": round(last30, 4),
            "gd_spot_median": gd_spot, "scale": round(scale, 4),
            "anchored_median": round(st.median(spot), 4),
            "anchored_last": spot[-1],
            "mean_abs_daily_move": round(sum(rets) / len(rets), 4),
            "on_demand_prefill": on_demand,
            "reserved_by_term": reserved,
            "coverage": gpus[slug]["coverage"],
            "gd_week": od_row["date"],
        }
        print(slug, summary[slug])

    out = {
        "generated": "2026-11-14",
        "note": ("Spot: AWS Spot Price History (Pauley, Zenodo 10.5281/zenodo.14254112), "
                 "us-east-1 daily medians, May-Nov 2024, rescaled by one constant per GPU so the "
                 "last-30-day median matches GetDeploying's current spot median. On-demand and "
                 "reserved prefills: GetDeploying weekly medians, week of the date in gdWeek."),
        "gdWeek": summary["h100"]["gd_week"],
        "gpus": gpus,
    }
    dest = ROOT / "docs" / "data" / "prices.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print("wrote", dest, f"{dest.stat().st_size/1024:.0f} KB")
    # The same data as a script, so the page also works from file://
    # (fetch of a local JSON file is blocked there).
    js_dest = ROOT / "docs" / "data" / "prices.js"
    js_dest.write_text("window.GPU_PRICES = " + json.dumps(out, separators=(",", ":")) + ";\n")
    print("wrote", js_dest, f"{js_dest.stat().st_size/1024:.0f} KB")
    (ROOT / "results" / "data_summary.json").write_text(json.dumps(summary, indent=2))
    print("wrote results/data_summary.json")

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(3, 1, figsize=(8, 6), sharex=False)
    for ax, (slug, cfg) in zip(axes, GPUS.items()):
        g = gpus[slug]
        ax.plot(g["days"], g["spot"], lw=0.8)
        ax.axhline(g["onDemand"], color="grey", ls="--", lw=0.8)
        ax.set_title(f"{cfg['label']} spot, $/GPU-hour (dashed: on-demand prefill)")
        ax.tick_params(labelsize=7)
        ax.set_xticks(g["days"][::60])
    fig.tight_layout()
    figdir = ROOT / "results" / "figures"
    figdir.mkdir(parents=True, exist_ok=True)
    fig.savefig(figdir / "spot_history.png", dpi=130)
    print("wrote results/figures/spot_history.png")


if __name__ == "__main__":
    main()
