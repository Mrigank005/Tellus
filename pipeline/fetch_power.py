"""Fetch NASA POWER monthly regional data for the Tellus domain.

Downloads each variable as 10-degree tiles from the POWER Monthly Regional API
(no authentication required), stores raw JSON per tile under data/raw/power/,
and records a per-run fetch manifest for provenance.

Usage:
    python pipeline/fetch_power.py [--force] [--vars T2M,PRECTOTCORR]
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import gzip
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from config_loader import load_config  # noqa: E402

CFG = load_config()
POWER = CFG["power"]
DOMAIN = CFG["domain"]

RAW_DIR = ROOT / "data" / "raw" / "power"
USER_AGENT = "Tellus/1.0 (NASA Space Apps challenge project; student hackathon)"


def build_url(param: str, lat_min: float, lat_max: float,
              lon_min: float, lon_max: float) -> str:
    return (
        f"{POWER['base_url']}?latitude-min={lat_min}&latitude-max={lat_max}"
        f"&longitude-min={lon_min}&longitude-max={lon_max}"
        f"&parameters={param}&community={POWER['community']}"
        f"&start={POWER['start_year']}&end={POWER['end_year']}&format=JSON"
    )


def tiles_for_domain():
    step = POWER["tile_degrees"]
    tiles = []
    for lat0 in frange(DOMAIN["lat_min"], DOMAIN["lat_max"], step):
        for lon0 in frange(DOMAIN["lon_min"], DOMAIN["lon_max"], step):
            tiles.append((lat0, min(lat0 + step, DOMAIN["lat_max"]),
                          lon0, min(lon0 + step, DOMAIN["lon_max"])))
    return tiles


def frange(start, stop, step):
    x = start
    while x < stop - 1e-9:
        yield round(x, 6)
        x += step


def fetch_one(param: str, tile, force: bool) -> dict:
    lat0, lat1, lon0, lon1 = tile
    out = RAW_DIR / param / f"lat{lat0:g}_lon{lon0:g}.json.gz"
    if out.exists() and not force:
        return {"param": param, "tile": tile, "file": str(out.relative_to(ROOT)),
                "status": "cached", "bytes": out.stat().st_size}
    time.sleep(POWER.get("politeness_delay_s", 0.0))

    url = build_url(param, lat0, lat1, lon0, lon1)
    last_err = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = resp.read()
            obj = json.loads(body)
            if "features" not in obj or not obj["features"]:
                raise ValueError(f"response has no features ({list(obj)[:5]})")
            out.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(out, "wb", compresslevel=6) as f:
                f.write(body)
            return {"param": param, "tile": tile, "file": str(out.relative_to(ROOT)),
                    "status": "ok", "bytes": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "url": url}
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError,
                json.JSONDecodeError, TimeoutError) as e:
            last_err = e
            time.sleep(2 ** attempt + 1.0)  # 2s, 3s, 5s, 9s, 17s
    return {"param": param, "tile": tile, "url": url, "status": "error",
            "error": str(last_err)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-download existing tiles")
    ap.add_argument("--vars", default="", help="comma-separated subset of variable ids")
    args = ap.parse_args()

    variables = CFG["variables"]
    if args.vars:
        wanted = {v.strip() for v in args.vars.split(",") if v.strip()}
        variables = [v for v in variables if v["power_parameter"] in wanted]
        missing = wanted - {v["power_parameter"] for v in variables}
        if missing:
            sys.exit(f"Unknown variables: {sorted(missing)}")

    tiles = tiles_for_domain()
    jobs = [(v["power_parameter"], t) for v in variables for t in tiles]
    print(f"Fetching {len(jobs)} tiles ({len(variables)} variables x {len(tiles)} tiles)")

    results = []
    with cf.ThreadPoolExecutor(max_workers=POWER["max_workers"]) as ex:
        futs = {ex.submit(fetch_one, p, t, args.force): (p, t) for p, t in jobs}
        done = 0
        for fut in cf.as_completed(futs):
            done += 1
            r = fut.result()
            results.append(r)
            mark = "ok" if r["status"] in ("ok", "cached") else "FAIL"
            print(f"[{done}/{len(jobs)}] {mark} {r['param']} {r['tile']} {r['status']}")

    errors = [r for r in results if r["status"] == "error"]
    manifest = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "NASA POWER Monthly Regional API",
        "source_url": POWER["base_url"],
        "start_year": POWER["start_year"],
        "end_year": POWER["end_year"],
        "requests": sorted(results, key=lambda r: (r["param"], str(r["tile"]))),
    }
    (RAW_DIR / "fetch_manifest.json").write_text(json.dumps(manifest, indent=1))

    print(f"\nDone: {len(results) - len(errors)} ok, {len(errors)} errors")
    if errors:
        print("Failed tiles (re-run to retry only these):")
        for e in errors:
            print(f"  {e['param']} {e['tile']}: {e['error']}")
        sys.exit(1)


if __name__ == "__main__":
    main()
