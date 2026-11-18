# Decisions

Choices the spec left open, settled by its decision rules or by the
more conservative option, with reasons.

1. **One region: us-east-1.** All three instance types have complete
   coverage there (214 of 214 days, May to November 2024). Pooling
   regions would mix distinct spot markets into a price nobody can
   actually pay; the region is named on the page.

2. **The older generation is the V100** (AWS p3.2xlarge, 1 GPU per
   instance). It is the older generation present in both sources: the
   AWS archive's p-family and GetDeploying's per-model files.

3. **Level anchoring.** The AWS archive's price level is from 2024
   (H100 spot median $6.11/GPU-hour in us-east-1), while the planning
   question is today's (GetDeploying's current on-demand median is
   $3.93). Shipping raw 2024 levels against 2026 prefills would make
   spot look unusable for the flagship GPU for a reason that is an
   artifact of the archive's vintage. So each series is multiplied by
   one constant setting its last-30-day median to GetDeploying's
   current spot median (H100 ×0.427, A100 ×0.546, V100 ×1.295). Log
   returns are unchanged, so every simulation and the coverage
   backtest measure the archive's dynamics; the level is today's
   market. Disclosed on the page, in the README and in DATA_SOURCES.md.

4. **Prefill statistics.** On-demand: GetDeploying's provider-median
   price (the dataset's headline statistic). Reserved: median listing
   price for the chosen term (provider medians for reserved listings
   are thinner and noisier). Both are starting points; every price is
   editable and the page says to use your own quote.

5. **Paths start at the median of the last 30 days**, not the single
   last observed day. The last archive day for A100 was a dip ($0.73
   against a $1.20 level); starting every path there would bias short
   plans. The coverage backtest uses the same convention.

6. **Block length 28 days.** A sweep (7/14/28/45) put 28 best or equal
   best in the coverage backtest. With the shipped settings the
   held-out coverage is H100 92%, A100 72%, V100 48%: the two warnings
   are reported on the page per GPU, not tuned away.

7. **Interruption loss is the expected half-interval.** In a daily
   model, tracking exact time since the last checkpoint makes the
   loss a sawtooth of the interval (any interval dividing 24 hours
   loses nothing). Charging half an interval of work per interruption
   (a uniform interruption point in the checkpoint cycle) is the
   standard expectation, is monotone in the interval, and is exactly
   hand-checkable, which the spec's test requires.

8. **Catch-up and fallback.** Spot capacity can catch up at up to
   three times its base rate (a fleet can be scaled up briefly; more
   would erase the deadline risk the tool exists to show). Fallback
   plans clear any undone spot work on on-demand in the last 7 days;
   a plan with no fallback that ends with a backlog finishes late at
   the on-demand price, so its cost stays comparable.

9. **The V100's reserved prices exceed its on-demand median** in the
   data (12-month reserved median $1.69 vs on-demand provider median
   $0.99; different, thinner provider sets). Kept as the data states,
   flagged in the README's limitations, not smoothed.

10. **One modes tab.** The skeleton's mode bar carries the single
    mode the spec defines, "Plan my compute"; no second mode was
    invented to fill it.

11. **Coverage pass band 78–97%** for a nominal 90% band: with 61
    held-out days, pure sampling noise around 90% is roughly ±8
    points, so the band is wide on purpose; 48% and 72% fail it
    clearly, 92% passes.

12. **The v-warn verdict is rare on real data by construction:**
    fallback plans never miss, so a feasible-but-risky winner needs
    all-spot to land in the narrow 2–5% miss band. All five verdict
    rules are exercised in the engine tests; on the page, v-good,
    v-accent, v-bad and the invalid-input state are reachable through
    the examples, and deadline risk surfaces through the LATE RISK
    check instead.

Revisions after review
----------------------

- **Interruptions from capacity reclaims, not only price.** AWS stopped
  interrupting spot instances over competing bids at the end of 2017;
  prices now move slowly and reclaims come when EC2 needs the capacity
  (AWS Compute Blog, "New Amazon EC2 Spot pricing model", March 2018).
  The price-cap mechanism alone produced almost no interruptions on these
  series, so checkpoints never mattered. Reclaims are now a per-node rate
  the user chooses; a lockstep job loses half a checkpoint interval of
  the whole fleet's work per reclaim. Counts per day are Poisson by
  inverse transform from one uniform per day and path, on a stream
  separate from prices and shared by every plan (common random numbers),
  so the engines still agree exactly.
- **Reservations are commitments.** Charging reserved GPUs per hour used
  made long terms look cheapest for short jobs. Reserved capacity is now
  whole GPUs for whole terms (months x 730 hours), unless the user says
  the GPUs go on to other work. Defaults and short-deadline examples use
  the 1-month term; the 2-year V100 quote appears twice, idle and reused,
  because the difference is the lesson.
- **Near ties go to the on-time plan.** Medians within 0.5% are a tie,
  decided by lower miss rate, then over-budget rate, then median.
- **Spot price move check (2026-11-18, PM review GBP-1).** The verdict
  is priced off one anchored spot level, and that level moves: Lambda
  raised its H100 list price about 14–15% in November 2026 while the
  tool's prefills sat at the week of November 9. A check in the verdict
  strip now re-runs every plan with the whole spot series scaled by
  0.8 and by 1.2 — one constant, so the log returns and dynamics are
  unchanged, the same trick as the level anchoring (#3) — holding the
  reserved and on-demand prices and the cap at the user's values. It
  states the winner's median at each moved level when the winner
  holds, and names the plan it changes to when it does not. The ±20%
  size brackets the November list-price rise; it is a stated stress
  size, not a forecast. When the winner flips, the message states how
  often a move that size actually happens in the selected GPU's
  shipped series, computed at page load — not a claim about a
  "normal month", which the first draft asserted and the
  2026-11-18 review removed: the frequency differs sharply by GPU.
  Definition: 30-day windows starting on every day of the shipped
  214-day daily spot series (184 windows), the move is
  (price 30 days later − price today) / price today, and the share
  counts windows with |move| ≥ 20%. On the shipped series that is
  H100 9%, A100 63%, V100 28% (pinned in tests/test_engine.py and
  mirrored in both engines as spot_move_share / spotMoveShare).
- **summarize() worst-set guard (2026-11-18 review).** When a
  strategy's simulated bills are all the same number — a constant
  spot series is the clean case — the interpolated 95th percentile
  can land 1 ulp above the maximum, leaving the worst-5% set empty:
  Python divided by zero, the JS mirror produced NaN. Both engines
  now fall back to the maximum bill, which is the shortfall of a
  single repeated bill. Behaviour on non-degenerate inputs is
  unchanged; a constant $0.80 series at paths_n=50 is pinned as a
  regression test in both engines.

## 2026-11-18: what a screen reader announces

- Only the verdict title is announced. The whole verdict panel used to
  be one `aria-live` region, and its KPI tiles and checks are rewritten
  on every run, so a screen reader read them all again after each pause
  in typing. Now the title alone carries `aria-live="polite"` and
  `aria-atomic="true"`: a changed verdict is announced in full, and the
  KPIs and checks stay on the page for the reader to move to. The title
  is written only when its text changes, so an unchanged verdict is not
  read out again.
