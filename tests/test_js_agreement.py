"""The page's engine (docs/gpuplan.js) and the Python reference must
agree: same seeded RNG stream, same strategy numbers, same verdict."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from gpubudget import engine

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not available")

PRICES = json.loads((ROOT / "docs" / "data" / "prices.json").read_text())

RUNNER = """
const G = require(process.argv[1]);
const job = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const rng = G.mulberry32(42);
const first5 = Array.from({length: 5}, () => rng());
const cases = job.cases.map(c => {
  const opts = {paths: c.paths, seed: c.seed, reclaim: c.reclaim || 0,
                termHours: c.termHours == null ? null : c.termHours};
  const out = G.plan(c.spot, c.hours, c.weeks, c.budget, c.ckpt, c.pRes, c.pOd, opts);
  const sens = G.priceSensitivity(c.spot, c.hours, c.weeks, c.budget, c.ckpt,
                                  c.pRes, c.pOd, opts);
  const moveShare = G.spotMoveShare(c.spot);
  return { first5, moveShare, strategies: out.strategies.map(s => ({
      id: s.id, median: s.median, p95: s.p95, es95: s.es95,
      pMiss: s.pMiss, pOver: s.pOver, lostHours: s.lostHours })),
    recommendation: out.recommendation,
    iidSpotMedian: out.iidSpotMedian, blockSpotMedian: out.blockSpotMedian,
    sens: sens };
});
console.log(JSON.stringify(cases));
"""


def _run_js(cases):
    proc = subprocess.run(
        [NODE, "-e", RUNNER, str(ROOT / "docs" / "gpuplan.js")],
        input=json.dumps({"cases": cases}), capture_output=True, text=True,
        timeout=300, cwd=ROOT)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


CASES = [
    {"gpu": "h100", "seed": 42, "hours": 2000, "weeks": 6, "budget": 9000.0,
     "ckpt": 2.0, "paths": 200},
    {"gpu": "a100", "seed": 7, "hours": 5000, "weeks": 3, "budget": None,
     "ckpt": 0.5, "paths": 200},
    {"gpu": "h100", "seed": 9, "hours": 40000, "weeks": 4, "budget": 120000.0,
     "ckpt": 4.0, "paths": 200, "reclaim": 1 / 24, "termHours": 730.0},
    {"gpu": "v100", "seed": 123, "hours": 1200, "weeks": 10, "budget": 1400.0,
     "ckpt": 24.0, "paths": 200},
]


def test_rng_stream_is_bit_exact():
    rand = engine.mulberry32(42)
    py = [rand() for _ in range(5)]
    out = _run_js([dict(CASES[0], spot=PRICES["gpus"]["h100"]["spot"],
                        pRes=3.21, pOd=3.93)])
    assert out[0]["first5"] == py


def test_plan_agrees_on_four_cases():
    jobs = []
    for c in CASES:
        g = PRICES["gpus"][c["gpu"]]
        jobs.append(dict(c, spot=g["spot"],
                         pRes=g["reservedByTerm"]["12"], pOd=g["onDemand"]))
    js = _run_js(jobs)
    for c, jout in zip(CASES, js):
        g = PRICES["gpus"][c["gpu"]]
        py = engine.plan(g["spot"], c["hours"], c["weeks"], c["budget"],
                         c["ckpt"], g["reservedByTerm"]["12"], g["onDemand"],
                         paths_n=c["paths"], seed=c["seed"],
                         reclaim=c.get("reclaim", 0.0),
                         term_hours=c.get("termHours"))
        assert engine.spot_move_share(g["spot"]) == jout["moveShare"]
        assert py["recommendation"]["id"] == jout["recommendation"]["id"]
        assert py["recommendation"]["cls"] == jout["recommendation"]["cls"]
        assert py["iid_spot_median"] == pytest.approx(jout["iidSpotMedian"], rel=1e-9)
        pys = engine.price_sensitivity(g["spot"], c["hours"], c["weeks"],
                                       c["budget"], c["ckpt"],
                                       g["reservedByTerm"]["12"], g["onDemand"],
                                       paths_n=c["paths"], seed=c["seed"],
                                       reclaim=c.get("reclaim", 0.0),
                                       term_hours=c.get("termHours"))
        for side in ("down", "up"):
            assert pys[side]["id"] == jout["sens"][side]["id"]
            assert pys[side]["cls"] == jout["sens"][side]["cls"]
            assert pys[side]["median"] == pytest.approx(
                jout["sens"][side]["median"], rel=1e-9)
        pstats = {s["id"]: s for s in py["strategies"]}
        for js_s in jout["strategies"]:
            ps = pstats[js_s["id"]]
            assert ps["median"] == pytest.approx(js_s["median"], rel=1e-9)
            assert ps["p95"] == pytest.approx(js_s["p95"], rel=1e-9)
            assert ps["es95"] == pytest.approx(js_s["es95"], rel=1e-9)
            assert ps["p_miss"] == pytest.approx(js_s["pMiss"], abs=1e-12)
            if js_s["pOver"] is None:
                assert ps["p_over"] is None
            else:
                assert ps["p_over"] == pytest.approx(js_s["pOver"], abs=1e-12)
            assert ps["lost_hours"] == pytest.approx(js_s["lostHours"], rel=1e-9)
