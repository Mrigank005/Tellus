"""Fetch real series from the challenge's open (no-login) resources.

Resources (NASA Space Apps 2026 resource list, "Be An Earth System Trend
Detective!"), and what this script does with each. Full findings are in
data/raw/missions/OPEN_RESOURCES.md.

  A. GES DISC "Hydrology Time Series" (former Data Rods)
     PROBE ONLY. The legacy REST endpoint is retired and the documented
     replacement API needs an Earthdata Login token. The script records the
     HTTP evidence and saves the public list of Giovanni time-series
     variables. It downloads no hydrology series.

  B. KNMI Climate Explorer (https://climexp.knmi.nl)
     GATED. The site asks every new computer / network to pass an
     "I verify that I am human" form first. This script NEVER submits that
     form. By default it only checks whether the gate is shown (1 request).
     After a person has passed the check in a browser on the same network,
     run with --knmi to download box averages. That path is UNVERIFIED: it
     was written from the published CGI source and has not run against the
     live site.

  C. NOAA NCEI Access Data Service (no token)
     WORKS. Monthly station TAVG and PRCP (Global Summary of the Month) for
     one station inside each of three preset regions. POINT data, not an
     area average.

Output (every data file is the raw server response, byte for byte):
  data/raw/missions/<VARIABLE_ID>/<region-id>.<ext>
  data/raw/missions/_open_probes/...      (probe evidence, not series)
  data/raw/missions/fetch_log_open.jsonl  (one JSON line per HTTP request)

Resumable: a data file that already exists is skipped. Nothing is ever
simulated, gap-filled or interpolated; a failed request is logged and the
file is simply not written.

Transport: curl (curl.exe --ssl-no-revoke on Windows) through subprocess,
because Python `requests` fails certificate revocation checks on some hosts
on the team's machine. Certificate verification stays ON.

Run:  python pipeline/fetch_open_resources.py            # A probes, B gate check, C download
      python pipeline/fetch_open_resources.py --knmi     # also B downloads (see above)
      python pipeline/fetch_open_resources.py --only ncei
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "missions"
PROBES = RAW / "_open_probes"
LOG = RAW / "fetch_log_open.jsonl"

# Generic on purpose: no project, team or personal details leave the machine.
USER_AGENT = "open-data-fetch/1.0 (curl)"

# Preset regions: id -> (lonMin, latMin, lonMax, latMax)
REGIONS = {
    "bengal-delta": (88, 21, 93, 25),
    "indo-gangetic-plain": (72, 22.5, 92, 31.5),
    "himalaya": (72, 28, 96, 36),
    "western-ghats": (73, 8, 75.5, 20),
    "thar-northwest": (68, 24, 75, 30),
    "amazon": (-75, -12, -48, 4),
    "sahel": (-17, 10, 35, 16),
    "congo-basin": (9, -6, 30, 4),
    "arctic": (-180, 66.5, 180, 90),
    "western-europe": (-10, 40, 25, 60),
    "us-great-plains": (-105, 32, -95, 49),
    "australian-outback": (114, -32, 142, -20),
    "maritime-southeast-asia": (95, -11, 130, 8),
    "siberia": (60, 55, 140, 75),
    "sahara": (-17, 16, 35, 30),
    "andes": (-80, -45, -64, 5),
    "greenland": (-55, 60, -20, 84),
    "nino34": (-170, -5, -120, 5),
    "southern-ocean": (-180, -70, 180, -45),
    "antarctica": (-180, -90, 180, -60),
    "tropics": (-180, -23.5, 180, 23.5),
    "whole-earth": (-180, -90, 180, 90),
}

# ---------------------------------------------------------------------------
# HTTP through curl, with a log line per request
# ---------------------------------------------------------------------------

CURL = shutil.which("curl.exe") or shutil.which("curl")


def _utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(entry: dict) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def http(url: str, *, resource: str, purpose: str, post: dict | None = None,
         timeout: int = 180) -> tuple[int, bytes, str]:
    """One request, redirects NOT followed. -> (status, body, redirect_url).

    status 0 means curl itself failed (DNS, TLS, timeout)."""
    if CURL is None:
        raise SystemExit("curl not found on PATH")
    fd, tmp = tempfile.mkstemp(prefix="open_fetch_", suffix=".part")
    os.close(fd)
    cmd = [CURL, "-sS", "-m", str(timeout), "-A", USER_AGENT, "-o", tmp,
           "-w", "%{http_code} %{redirect_url}"]
    if os.name == "nt":
        cmd.insert(1, "--ssl-no-revoke")
    if post is not None:
        for k, v in post.items():
            cmd += ["--data-urlencode", f"{k}={v}"]
    cmd.append(url)
    started = _utc()
    status, redirect, err = 0, "", ""
    try:
        res = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=timeout + 30)
        parts = res.stdout.strip().split(" ", 1)
        status = int(parts[0]) if parts and parts[0].isdigit() else 0
        redirect = parts[1].strip() if len(parts) > 1 else ""
        err = res.stderr.strip()
    except subprocess.TimeoutExpired:
        err = "curl timed out"
    body = Path(tmp).read_bytes() if os.path.exists(tmp) else b""
    try:
        os.remove(tmp)
    except OSError:
        pass
    entry = {"utc": started, "resource": resource, "purpose": purpose,
             "method": "POST" if post is not None else "GET", "url": url,
             "status": status, "bytes": len(body)}
    if post is not None:
        entry["post"] = post
    if redirect:
        entry["redirect"] = redirect
    if err:
        entry["curl_error"] = err[:300]
    log(entry)
    return status, body, redirect


def save_raw(path: Path, body: bytes, url: str) -> None:
    """Write the response exactly as received and note it in the log."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    log({"utc": _utc(), "event": "saved", "url": url, "bytes": len(body),
         "file": str(path.relative_to(ROOT)).replace("\\", "/")})
    print(f"  saved {path.relative_to(ROOT)} ({len(body)} bytes)")


# ---------------------------------------------------------------------------
# C. NOAA NCEI Access Data Service: Global Summary of the Month (station)
# ---------------------------------------------------------------------------

NCEI_DATA = "https://www.ncei.noaa.gov/access/services/data/v1"
NCEI_START, NCEI_END = "1850-01-01", "2026-10-31"

# One station per region, chosen 2026-11-14 as the station inside the box
# with the most TAVG+PRCP months since 2000 (see OPEN_RESOURCES.md).
NCEI_STATIONS = {
    "bengal-delta": "BGM00041978",         # Shah Amanat Intl (Chattogram), BG
    "indo-gangetic-plain": "IN022021900",  # New Delhi Safdarjung, IN
    "western-europe": "NLM00006260",       # De Bilt, NL
}
NCEI_VARIABLES = {"NCEI_GSOM_TAVG": "TAVG", "NCEI_GSOM_PRCP": "PRCP"}


def ncei_url(station: str, datatype: str) -> str:
    q = {"dataset": "global-summary-of-the-month", "stations": station,
         "dataTypes": datatype, "startDate": NCEI_START, "endDate": NCEI_END,
         "format": "csv", "units": "metric"}
    return NCEI_DATA + "?" + urllib.parse.urlencode(q)


def fetch_ncei(pause: float) -> None:
    print("C. NOAA NCEI Access Data Service (GSOM station data)")
    for var_id, datatype in NCEI_VARIABLES.items():
        for region, station in NCEI_STATIONS.items():
            out = RAW / var_id / f"{region}.csv"
            if out.exists() and out.stat().st_size > 0:
                print(f"  cached {out.relative_to(ROOT)}")
                continue
            url = ncei_url(station, datatype)
            status, body, _ = http(url, resource="C-NCEI",
                                   purpose=f"{var_id}/{region}")
            head = body[:200].decode("utf-8", "replace").splitlines()
            expected = f'"STATION","DATE","{datatype}"'
            if status == 200 and head and head[0].strip() == expected \
                    and body.count(b"\n") >= 13:
                save_raw(out, body, url)
            else:
                print(f"  FAILED {var_id}/{region}: status {status}, "
                      f"first line {head[:1]}")
            time.sleep(pause)

    # Station name / coordinates as the server reports them (evidence only).
    meta = PROBES / "ncei_gsom_station_metadata.csv"
    if not meta.exists():
        q = {"dataset": "global-summary-of-the-month",
             "stations": ",".join(NCEI_STATIONS.values()),
             "dataTypes": "TAVG,PRCP", "startDate": "2020-01-01",
             "endDate": "2020-12-31", "format": "csv", "units": "metric",
             "includeStationName": "true", "includeStationLocation": "1"}
        url = NCEI_DATA + "?" + urllib.parse.urlencode(q)
        status, body, _ = http(url, resource="C-NCEI",
                               purpose="station metadata")
        if status == 200 and body.startswith(b'"STATION"'):
            save_raw(meta, body, url)


# ---------------------------------------------------------------------------
# A. GES DISC Hydrology Time Series: probes only
# ---------------------------------------------------------------------------

def probe_hydrology(pause: float) -> None:
    print("A. GES DISC Hydrology Time Series (probe only)")
    legacy = ("https://hydro1.gesdisc.eosdis.nasa.gov/daac-bin/access/"
              "timeseries.cgi?variable=GLDAS2:GLDAS_NOAH025_M_v2.1:Qs_acc"
              "&location=GEOM:POINT(90,%2023)&startDate=2000-01-01T00"
              "&endDate=2001-01-01T00&type=asc2")
    status, _, redirect = http(legacy, resource="A-HYDRO",
                               purpose="legacy data rods endpoint")
    print(f"  legacy data-rods endpoint: HTTP {status}"
          + (f" -> {redirect[:90]}..." if redirect else ""))
    time.sleep(pause)

    api = ("https://api.giovanni.earthdata.nasa.gov/timeseries"
           "?data=GLDAS_NOAH025_M_2_1_Qs_acc&location=%5B23.5%2C90%5D"
           "&time=2000-01-01T00%3A00%3A00%2F2000-12-31T23%3A59%3A59")
    status, body, _ = http(api, resource="A-HYDRO",
                           purpose="documented API without a token")
    print(f"  documented time-series API without token: HTTP {status} "
          f"{body[:120].decode('utf-8', 'replace').strip()!r}")
    time.sleep(pause)

    out = PROBES / "giovanni_configured_variables.json"
    if out.exists():
        print(f"  cached {out.relative_to(ROOT)}")
        return
    url = "https://api.giovanni.earthdata.nasa.gov/configured-variables/"
    status, body, _ = http(url, resource="A-HYDRO",
                           purpose="public list of time-series variables")
    if status == 200 and body.lstrip().startswith(b"{"):
        save_raw(out, body, url)
    else:
        print(f"  configured-variables: HTTP {status}")


# ---------------------------------------------------------------------------
# B. KNMI Climate Explorer: gate check, optional (UNVERIFIED) download
# ---------------------------------------------------------------------------

KNMI = "https://climexp.knmi.nl"
KNMI_ID = "someone@somewhere"          # the site's own anonymous user id
KNMI_MAX_REQUESTS = 150
KNMI_PAUSE = 3.0

LAND = ["bengal-delta", "indo-gangetic-plain", "himalaya", "western-ghats",
        "thar-northwest", "amazon", "sahel", "congo-basin", "western-europe",
        "us-great-plains", "australian-outback", "maritime-southeast-asia",
        "siberia", "sahara", "andes"]
OCEAN = ["nino34", "southern-ocean", "bengal-delta",
         "maritime-southeast-asia", "tropics", "whole-earth"]

# Field names come from the published Climate Explorer CGI source
# (queryfield.cgi). UNVERIFIED against the live site.
KNMI_FIELDS = {
    "KNMI_OISSTV2_SST": {"field": "sstoi_v2", "regions": OCEAN},
    "KNMI_NOAACDR_NDVI": {"field": "ndvi_noaa_05", "regions": LAND},
    "KNMI_CMORPH_PRECIP": {"field": "cmorph_monthly", "regions": LAND},
}


def knmi_gate_shown(body: bytes) -> bool:
    text = body.decode("latin-1", "replace")
    return 'name="challenge"' in text or "verify that I am human" in text


def fetch_knmi(download: bool) -> None:
    print("B. KNMI Climate Explorer")
    used = 1
    status, body, _ = http(f"{KNMI}/start.cgi?id={KNMI_ID}", resource="B-KNMI",
                           purpose="gate check")
    if status != 200:
        print(f"  start page: HTTP {status}; nothing downloaded")
        return
    if knmi_gate_shown(body):
        print("  The site shows its 'I verify that I am human' form for this "
              "network.\n  This script does not submit it. Open "
              f"{KNMI}/ in a browser on this network,\n  click the "
              "verification button yourself, then re-run with --knmi.")
        log({"utc": _utc(), "event": "knmi-gated",
             "note": "human verification form shown; no data requested"})
        return
    print("  no verification form shown for this network")
    if not download:
        print("  (run with --knmi to download box averages; UNVERIFIED path)")
        return

    for var_id, spec in KNMI_FIELDS.items():
        for region in spec["regions"]:
            out = RAW / var_id / f"{region}.dat"
            if out.exists() and out.stat().st_size > 0:
                print(f"  cached {out.relative_to(ROOT)}")
                continue
            if used + 2 > KNMI_MAX_REQUESTS:
                print("  request budget reached; stopping politely")
                return
            lon1, lat1, lon2, lat2 = REGIONS[region]
            form = {"email": KNMI_ID, "field": spec["field"],
                    "lat1": lat1, "lat2": lat2, "lon1": lon1, "lon2": lon2,
                    "intertype": "nearest", "gridpoints": "false",
                    "masktype": "all", "minfac": "30"}
            time.sleep(KNMI_PAUSE)
            status, page, _ = http(f"{KNMI}/get_index.cgi", post=form,
                                   resource="B-KNMI",
                                   purpose=f"{var_id}/{region} box average",
                                   timeout=300)
            used += 1
            if status != 200 or knmi_gate_shown(page):
                print(f"  FAILED {var_id}/{region}: HTTP {status} or gated")
                if knmi_gate_shown(page):
                    return
                continue
            m = re.search(r'href="/?(data/i[^"\s]+\.dat)"',
                          page.decode("latin-1", "replace"))
            if not m:
                print(f"  FAILED {var_id}/{region}: no data link in reply")
                continue
            time.sleep(KNMI_PAUSE)
            url = f"{KNMI}/{m.group(1)}"
            status, data, _ = http(url, resource="B-KNMI",
                                   purpose=f"{var_id}/{region} series file")
            used += 1
            first = data.lstrip()[:1]
            if status == 200 and len(data) > 200 and (
                    first == b"#" or first.isdigit()):
                save_raw(out, data, url)
            else:
                print(f"  FAILED {var_id}/{region}: HTTP {status}, "
                      f"{len(data)} bytes, not a series file")


# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", choices=["hydro", "knmi", "ncei"],
                    help="run a single resource")
    ap.add_argument("--knmi", action="store_true",
                    help="download KNMI box averages if the site shows no "
                         "human-verification form (UNVERIFIED path)")
    ap.add_argument("--pause", type=float, default=1.5,
                    help="seconds between NASA / NOAA requests")
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    if args.only in (None, "ncei"):
        fetch_ncei(args.pause)
    if args.only in (None, "hydro"):
        probe_hydrology(args.pause)
    if args.only in (None, "knmi"):
        fetch_knmi(args.knmi)
    print(f"Log: {LOG.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
