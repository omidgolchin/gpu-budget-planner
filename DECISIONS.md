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
