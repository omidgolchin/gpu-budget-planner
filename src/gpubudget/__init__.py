"""GPU Budget Planner: reference engine (mirrors docs/gpuplan.js)."""

from .engine import (
    STRATEGIES,
    iid_returns,
    log_returns,
    mulberry32,
    percentile,
    plan,
    recommend,
    run_strategy,
    sample_paths,
    start_price,
    summarize,
)

__all__ = [
    "STRATEGIES",
    "iid_returns",
    "log_returns",
    "mulberry32",
    "percentile",
    "plan",
    "recommend",
    "run_strategy",
    "sample_paths",
    "start_price",
    "summarize",
]
