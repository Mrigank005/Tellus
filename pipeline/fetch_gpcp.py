"""Fetch the GPCP V2.3 monthly precipitation file (no authentication needed).

Source: NOAA PSL, https://psl.noaa.gov/data/gridded/data.gpcp.html
"""
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from config_loader import load_config  # noqa: E402

CFG = load_config()
GPCP = CFG["gpcp"]
OUT = ROOT / "data" / "raw" / "gpcp" / "precip.mon.mean.nc"


def main():
    if OUT.exists() and OUT.stat().st_size > 10_000_000:
        print(f"Cached: {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {GPCP['url']} ...")
    req = urllib.request.Request(GPCP["url"],
                                 headers={"User-Agent": "Tellus/1.0 (hackathon)"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(OUT, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    manifest = {
        "url": GPCP["url"],
        "version": GPCP["version"],
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "bytes": OUT.stat().st_size,
    }
    (OUT.parent / "fetch_manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"Saved {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
