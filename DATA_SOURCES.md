# Data sources

Two sources, both CC BY 4.0. `scripts/download_data.py` fetches them;
`scripts/process_data.py` turns them into `docs/data/prices.json`, the
only file the page reads. Raw downloads are kept in `data/raw/`.

## AWS Spot Price History (spot price dynamics)

- **Citation:** Pauley, Eric (2024). *AWS Spot Price History* [Data
  set]. Zenodo. https://doi.org/10.5281/zenodo.14254112
- **License:** CC BY 4.0.
- **What was taken:** the monthly archives for May to November 2024
  (the record's monthly files), streamed and filtered on download to
  Linux/UNIX rows for three instance types: p5.48xlarge (8 × H100),
  p4d.24xlarge (8 × A100), p3.2xlarge (1 × V100). The filtered
  extracts (31,097 rows) are in `data/raw/aws-spot/`. Availability
  zone identifiers are the archive's anonymized global ids; the
  region prefix `use1` is us-east-1.
- **How it is used:** us-east-1 only. For each day and zone, the last
  price observed that day; the day's price is the median across
  zones, divided by the GPUs in the instance. That gives 214 daily
  prices per GPU, 2024-05-01 to 2024-11-30. The series is then
  multiplied by one constant per GPU (see *Level anchoring* below);
  its day-to-day changes are used exactly as archived.

## GetDeploying GPU price history (current price level and prefills)

- **Credit (as the dataset page requires):** GetDeploying, GPU rental
  price history, https://getdeploying.com/gpus, CC BY 4.0
- **Citation:** GetDeploying (2026). *GPU rental price history*
  [dataset]. https://getdeploying.com/dataset/gpu-prices. Accessed
  November 14, 2026.
- **License:** CC BY 4.0.
- **What was taken:** the per-model weekly files `nvidia-h100.csv`
  (538 data rows), `nvidia-a100.csv` (509) and `nvidia-v100.csv`
  (355): weekly median listing prices by billing type over the
  trailing 53 weeks (2025-11-10 to 2026-11-09), in
  `data/raw/getdeploying/`.
- **How it is used:** from the latest week (2026-11-09): the
  on-demand prefill is the provider-median price (H100 $3.93, A100
  $1.91, V100 $0.99 per GPU-hour); reserved prefills are the median
  listing prices by reservation term (for 12 months: H100 $3.21, A100
  $1.65, V100 $1.69); the spot medians (provider-median: H100 $2.48,
  A100 $1.20, V100 $0.96) set the level anchor below. All prefills are
  editable on the page.

## Level anchoring (one transformation, applied openly)

The AWS archive's levels are from 2024 and the prefills are from
November 2026, so each daily series is multiplied by a single
constant chosen so its last-30-day median equals GetDeploying's
current spot median for that GPU (H100 ×0.4267, A100 ×0.5463, V100
×1.2946). Multiplication by a constant does not change log returns,
so the simulations, the interruption behavior and the coverage
backtest all measure the archive's dynamics; only the level is
current. The raw (unscaled) medians are recorded in
`results/data_summary.json`.
