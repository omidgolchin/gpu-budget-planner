#!/usr/bin/env python3
"""Download the two price datasets this tool is built on.

Sources (both CC BY 4.0; see DATA_SOURCES.md for the exact citations):

1. AWS Spot Price History, Eric Pauley, Zenodo DOI 10.5281/zenodo.14254112.
   Monthly .tsv.zst files in the format of AWS describe-spot-price-history
   (AZ ids are global ids, e.g. use1-az1). The files are large (about
   100 MB compressed each), so they are streamed and filtered on the fly:
   only the GPU instance types below, Linux/UNIX, are kept.

2. GetDeploying GPU rental price history (weekly medians per GPU model,
   including SPOT and RESERVATION rows). One CSV per GPU model.

Output: data/raw/aws-spot/filtered-YYYY-MM.tsv and
data/raw/getdeploying/<slug>.csv. Nothing here is read by the page; run
scripts/process_data.py afterwards to build docs/data/prices.json.
"""

import io
import sys
import urllib.request
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

ZENODO = "https://zenodo.org/api/records/14254112/files/{}/content"
MONTHS = ["2024-05", "2024-06", "2024-07", "2024-08", "2024-09", "2024-10", "2024-11"]

# instance type -> (gpu slug, gpus per instance)
INSTANCES = {
    "p5.48xlarge": ("h100", 8),
    "p4d.24xlarge": ("a100", 8),
    "p3.2xlarge": ("v100", 1),
}

GETDEPLOYING = "https://getdeploying.com/dataset/gpu-prices/{}.csv"
GD_SLUGS = ["nvidia-h100", "nvidia-a100", "nvidia-v100", "weekly"]


def fetch(url: str) -> urllib.request.Request:
    return urllib.request.Request(url, headers={"User-Agent": "gpu-budget-planner data fetch (CC BY attribution in DATA_SOURCES.md)"})


def download_aws() -> None:
    outdir = RAW / "aws-spot"
    outdir.mkdir(parents=True, exist_ok=True)
    keep = tuple(INSTANCES)
    for month in MONTHS:
        dest = outdir / f"filtered-{month}.tsv"
        if dest.exists() and dest.stat().st_size > 0:
            print(f"aws {month}: already downloaded, skipping")
            continue
        url = ZENODO.format(f"{month}.tsv.zst")
        print(f"aws {month}: streaming {url}")
        kept = 0
        with urllib.request.urlopen(fetch(url), timeout=600) as resp, \
                zstandard.ZstdDecompressor().stream_reader(resp) as reader, \
                io.TextIOWrapper(reader, encoding="utf-8", newline="") as text, \
                open(dest, "w", encoding="utf-8") as out:
            for line in text:
                # columns: az, instance type, product description, price, timestamp
                parts = line.split("\t")
                if len(parts) >= 5 and parts[1] in keep and parts[2] == "Linux/UNIX":
                    out.write(line)
                    kept += 1
        print(f"aws {month}: kept {kept} rows -> {dest.name} ({dest.stat().st_size/1e6:.1f} MB)")


def download_getdeploying() -> None:
    outdir = RAW / "getdeploying"
    outdir.mkdir(parents=True, exist_ok=True)
    for slug in GD_SLUGS:
        dest = outdir / f"{slug}.csv"
        url = GETDEPLOYING.format(slug)
        print(f"getdeploying {slug}: {url}")
        with urllib.request.urlopen(fetch(url), timeout=120) as resp:
            data = resp.read()
        if b"gpu_slug" not in data[:200]:
            raise RuntimeError(f"{slug}: unexpected content (no gpu_slug header)")
        dest.write_bytes(data)
        print(f"getdeploying {slug}: {len(data)/1024:.0f} KB")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "aws"):
        download_aws()
    if which in ("all", "getdeploying"):
        download_getdeploying()
    print("done")
