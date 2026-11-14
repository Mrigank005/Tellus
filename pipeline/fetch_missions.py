"""Fetch area-averaged time series for mission / model variables from NASA
Giovanni (Cloud Giovanni, GES DISC) for every preset region.

    python pipeline/fetch_missions.py --dry-run          # print the requests only
    python pipeline/fetch_missions.py --list             # show the variable table
    python pipeline/fetch_missions.py                    # default variables x all regions
    python pipeline/fetch_missions.py --variables IMERG_PRECIP --regions bengal-delta,himalaya --limit 2

What it does, per variable x region:
  1. reads the fraction of the monthly Giovanni compute quota already used
     (GET https://api.giovanni.earthdata.nasa.gov/quota) and stops cleanly
     before it is exhausted;
  2. submits one Harmony job to the Giovanni averaging service
     (average=area, format=text/csv) for the region's bounding box and the
     full record of the variable, waits for it, downloads the result;
  3. saves the server response UNCHANGED to
     data/raw/missions/<our-id>/<region-id>.csv and appends one line to
     data/raw/missions/fetch_log.jsonl.
Files that already exist are skipped, so the run is resumable.

Nothing is ever simulated, repaired or interpolated here: if a request fails,
no data file is written and the failure is logged.

Credentials (an Earthdata Login bearer token), looked up in this order:
  1. environment variable EARTHDATA_TOKEN
  2. file <Prototype>/.earthdata_token   (one line; keep it out of git)
  3. ~/.netrc or ~/_netrc, machine urs.earthdata.nasa.gov  (username/password
     are exchanged for a token at urs.earthdata.nasa.gov; nothing is stored)
The token is only ever sent in the Authorization header. It is never printed
and never written to any file or log.

The HTTP requests are the ones harmony-py builds for
    Request(collection=Collection(id=<concept id>), spatial=BBox(w, s, e, n),
            temporal={start, stop}, variables=[<Giovanni id>],
            format="text/csv", average="area")
(see the GES DISC tutorial "How To Access the Giovanni Averaging Service Using
Python"), sent with plain `requests`; harmony-py and earthaccess are not needed.

Variable ids, units and record spans were checked on 2026-11-14 against
https://api.giovanni.earthdata.nasa.gov/configured-variables/ and the CMR.
See data/raw/missions/MAPPING.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import netrc
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
DOMAIN_JSON = ROOT / "config" / "domain.json"
RAW = ROOT / "data" / "raw" / "missions"
LOG = RAW / "fetch_log.jsonl"
TOKEN_FILE = ROOT / ".earthdata_token"

GIOVANNI_API = "https://api.giovanni.earthdata.nasa.gov"
QUOTA_URL = GIOVANNI_API + "/quota"
CONFIGURED_URL = GIOVANNI_API + "/configured-variables/"
HARMONY = "https://harmony.earthdata.nasa.gov"
URS_TOKEN_URL = "https://urs.earthdata.nasa.gov/api/users/find_or_create_token"
CMR_GRANULES = "https://cmr.earthdata.nasa.gov/search/granules.json"
USER_AGENT = "Tellus/1.0 (hackathon; python-requests)"

TERMINAL = {"successful", "failed", "canceled", "complete_with_errors"}
LAND_ONLY_SKIP = ("nino34", "southern-ocean", "antarctica")   # GLDAS: land, 60S-90N
OCEAN_ONLY_SKIP = ()

# ---------------------------------------------------------------------------
# Our id -> Giovanni configured variable.
#   giovanni_id   exact id from /configured-variables/ (verified 2026-11-14)
#   concept_id    CMR collection concept id (verified 2026-11-14)
#   level         vertical level to select; None = variable is 2-D. No
#                 pressure-level variable is configured in Cloud Giovanni.
#   units         native units of the variable (CMR UMM-Var). The units
#                 Giovanni writes in the CSV header are authoritative.
#   resolution    "monthly" | "daily"
#   record        (first granule start, last granule end seen 2026-11-14);
#                 refreshed from the CMR at run time, used only as a fallback
#   default       fetched when --variables is not given
# ---------------------------------------------------------------------------
VARIABLES: dict[str, dict] = {
    "IMERG_PRECIP": {
        "giovanni_id": "GPM_3IMERGM_07_precipitation",
        "concept_id": "C2723754851-GES_DISC", "level": None,
        "units": "mm/hr", "resolution": "monthly",
        "record": ("1998-01-01T00:00:00", "2025-09-30T23:59:59"),
        "default": True,
        "note": "GPM IMERG Final Run V07 monthly, 0.1 deg",
    },
    "GLDAS_RUNOFF": {
        "giovanni_id": "GLDAS_NOAH025_M_2_1_Qs_acc",
        "concept_id": "C1342986036-GES_DISC", "level": None,
        "units": "kg m-2 (mean 3-hourly accumulation)", "resolution": "monthly",
        "record": ("2000-01-01T00:00:00", "2026-07-31T23:59:59"),
        "default": True, "skip_regions": LAND_ONLY_SKIP,
        "note": "GLDAS Noah 2.1 storm surface runoff, 0.25 deg, land only",
    },
    "GLDAS_ET": {
        "giovanni_id": "GLDAS_NOAH025_M_2_1_Evap_tavg",
        "concept_id": "C1342986036-GES_DISC", "level": None,
        "units": "kg m-2 s-1", "resolution": "monthly",
        "record": ("2000-01-01T00:00:00", "2026-07-31T23:59:59"),
        "default": True, "skip_regions": LAND_ONLY_SKIP,
        "note": "GLDAS Noah 2.1 evapotranspiration",
    },
    "GLDAS_SOILM": {
        "giovanni_id": "GLDAS_NOAH025_M_2_1_SoilMoi0_10cm_inst",
        "concept_id": "C1342986036-GES_DISC", "level": None,
        "units": "kg m-2", "resolution": "monthly",
        "record": ("2000-01-01T00:00:00", "2026-07-31T23:59:59"),
        "default": True, "skip_regions": LAND_ONLY_SKIP,
        "note": "GLDAS Noah 2.1 soil moisture 0-10 cm",
    },
    "AIRS_TSURF": {
        "giovanni_id": "AIRS3STM_7_0_SurfAirTemp_A",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "K", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": True,
        "note": "AIRS-only V7.0 surface air temperature, ascending (daytime, "
                "~13:30 local). Fallback for AIRS_T500, which is NOT configured.",
    },
    "OMI_NO2": {
        "giovanni_id": "OMNO2d_003_ColumnAmountNO2TropCloudScreened",
        "concept_id": "C1266136111-GES_DISC", "level": None,
        "units": "molecules/cm^2", "resolution": "daily",
        "record": ("2004-10-01T00:00:00", "2026-03-15T23:59:59"),
        "default": True,
        "note": "OMI/Aura tropospheric NO2 column, 30% cloud screened, 0.25 deg. "
                "DAILY (about 7800 time steps): the most expensive request, run last.",
    },
    # ---- extras: not fetched unless named in --variables (or --variables all)
    "AIRS_TSURF_NIGHT": {
        "giovanni_id": "AIRS3STM_7_0_SurfAirTemp_D",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "K", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": False, "note": "descending (night, ~01:30 local)",
    },
    "AIRS_TROPOPAUSE_TEMP": {
        "giovanni_id": "AIRS3STM_7_0_TropTemp_A",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "K", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": False, "note": "the only upper-air AIRS temperature configured",
    },
    "AIRS_WATER_VAPOR": {
        "giovanni_id": "AIRS3STM_7_0_TotH2OVap_A",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "kg/m2", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": False, "note": "total column water vapour",
    },
    "AIRS_OLR": {
        "giovanni_id": "AIRS3STM_7_0_OLR_A",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "W/m2", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": False, "note": "outgoing longwave radiation",
    },
    "AIRS_TOTAL_OZONE": {
        "giovanni_id": "AIRS3STM_7_0_TotO3_A",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "DU", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": False, "note": "total column ozone",
    },
    "AIRS_CLOUD_FRACTION": {
        "giovanni_id": "AIRS3STM_7_0_CloudFrc_A",
        "concept_id": "C1701805662-GES_DISC", "level": None,
        "units": "fraction (0-1)", "resolution": "monthly",
        "record": ("2002-09-01T00:00:00", "2026-11-01T00:00:00"),
        "default": False, "note": "cloud fraction",
    },
    "TRMM_PRECIP": {
        "giovanni_id": "TRMM_3B43_7_precipitation",
        "concept_id": "C1282032631-GES_DISC", "level": None,
        "units": "mm/hr", "resolution": "monthly",
        "record": ("1998-01-01T00:00:00", "2019-12-31T23:59:59"),
        "default": False,
        "skip_regions": ("arctic", "antarctica", "greenland", "siberia",
                         "southern-ocean"),
        "note": "TRMM TMPA 3B43 V7, 50S-50N only, ended 2019-12",
    },
    "GLDAS_BASEFLOW": {
        "giovanni_id": "GLDAS_NOAH025_M_2_1_Qsb_acc",
        "concept_id": "C1342986036-GES_DISC", "level": None,
        "units": "kg m-2 (mean 3-hourly accumulation)", "resolution": "monthly",
        "record": ("2000-01-01T00:00:00", "2026-07-31T23:59:59"),
        "default": False, "skip_regions": LAND_ONLY_SKIP,
        "note": "baseflow-groundwater runoff",
    },
    "GLDAS_SWE": {
        "giovanni_id": "GLDAS_NOAH025_M_2_1_SWE_inst",
        "concept_id": "C1342986036-GES_DISC", "level": None,
        "units": "kg m-2", "resolution": "monthly",
        "record": ("2000-01-01T00:00:00", "2026-07-31T23:59:59"),
        "default": False, "skip_regions": LAND_ONLY_SKIP,
        "note": "snow water equivalent",
    },
    "GLDAS_TAIR": {
        "giovanni_id": "GLDAS_NOAH025_M_2_1_Tair_f_inst",
        "concept_id": "C1342986036-GES_DISC", "level": None,
        "units": "K", "resolution": "monthly",
        "record": ("2000-01-01T00:00:00", "2026-07-31T23:59:59"),
        "default": False, "skip_regions": LAND_ONLY_SKIP,
        "note": "near-surface air temperature (forcing)",
    },
    "MERRA2_T2M": {
        "giovanni_id": "M2IMNXASM_5_12_4_T2M",
        "concept_id": "C1276812823-GES_DISC", "level": None,
        "units": "K", "resolution": "monthly",
        "record": ("1980-01-01T00:00:00", "2026-09-30T23:00:00"),
        "default": False, "note": "MERRA-2 monthly 2 m air temperature",
    },
    "MERRA2_TOTAL_OZONE": {
        "giovanni_id": "M2IMNXASM_5_12_4_TO3",
        "concept_id": "C1276812823-GES_DISC", "level": None,
        "units": "Dobsons", "resolution": "monthly",
        "record": ("1980-01-01T00:00:00", "2026-09-30T23:00:00"),
        "default": False, "note": "MERRA-2 monthly total column ozone",
    },
    "OMI_AOD_500": {
        "giovanni_id": "OMAERUVd_003_FinalAerosolOpticalDepth500",
        "concept_id": "C1266136096-GES_DISC", "level": None,
        "units": "1", "resolution": "daily",
        "record": ("2004-10-01T00:00:00", "2026-11-08T23:59:59"),
        "default": False,
        "note": "OMI near-UV aerosol optical depth at 500 nm, 1 deg, DAILY. "
                "Not MODIS: the nearest aerosol variable that is configured.",
    },
    "NOBM_TOTAL_CHL": {
        "giovanni_id": "NOBM_DAY_R2017_tot",
        "concept_id": "C1404080675-GES_DISC", "level": None,
        "units": "mg m-3", "resolution": "daily",
        "record": ("1998-01-01T00:00:00", "2015-12-31T23:59:59"),
        "default": False,
        "skip_regions": ("himalaya", "thar-northwest", "sahara", "sahel",
                         "congo-basin", "us-great-plains", "australian-outback",
                         "siberia"),
        "note": "NASA Ocean Biogeochemical MODEL total chlorophyll (assimilates "
                "SeaWiFS/MODIS chlorophyll), DAILY, 1998-2015 = 18 years, which "
                "is under the 20-year threshold. Not a satellite product.",
    },
}

# Targets that are NOT configured in Cloud Giovanni (checked 2026-11-14).
UNAVAILABLE = {
    "AIRS_T500": "AIRS air temperature on pressure levels (AIRS3STM Temperature_A) "
                 "is not configured: only 2-D AIRS fields are. Fallbacks: "
                 "AIRS_TSURF, AIRS_TROPOPAUSE_TEMP.",
    "MODIS_NDVI": "no MODIS collection (MOD13C2 or any other) is configured.",
    "MODIS_AOD": "no MODIS collection (MOD08_M3 / MYD08_M3) is configured. "
                 "Nearest configured aerosol variable: OMI_AOD_500 (daily, OMI).",
    "CHLOROPHYLL": "no MODIS-Aqua or SeaWiFS ocean-colour collection is configured. "
                   "Nearest: NOBM_TOTAL_CHL (model, daily, 1998-2015).",
}

DEFAULT_REGION_ORDER = [
    "bengal-delta", "indo-gangetic-plain", "himalaya", "western-ghats",
    "thar-northwest", "amazon", "sahel", "congo-basin", "arctic",
    "western-europe", "us-great-plains", "australian-outback",
    "maritime-southeast-asia", "siberia", "sahara", "andes", "greenland",
    "nino34", "southern-ocean", "antarctica", "tropics", "whole-earth",
]

TOKEN_HELP = """
No Earthdata Login credentials found. Nothing was downloaded.

Get a token (free, about 2 minutes):
  1. Sign in (or register) at https://urs.earthdata.nasa.gov
  2. Top menu: "Generate Token"  ->  button "GENERATE TOKEN"
  3. Copy the long token string (it starts with "eyJ..."; valid for 60 days).

Give it to this script in ONE of these ways:
  a) environment variable (recommended, nothing is written to disk)
       PowerShell:  $env:EARTHDATA_TOKEN = "<paste token>"
       Git Bash:    export EARTHDATA_TOKEN="<paste token>"
  b) a one-line file:  {token_file}
     (make sure ".earthdata_token" is listed in .gitignore)
  c) ~/.netrc (or ~/_netrc) with the line
       machine urs.earthdata.nasa.gov login <username> password <password>

Then run:   python pipeline/fetch_missions.py

If requests are refused with 401/403 although the token is new, open
https://urs.earthdata.nasa.gov -> Applications -> Authorized Apps and approve
"NASA GESDISC DATA ARCHIVE".
"""


# ---------------------------------------------------------------------------
# HTTP: requests first; curl.exe --ssl-no-revoke if certificate checks fail.
# Certificate verification is never switched off.
# ---------------------------------------------------------------------------

class AuthError(Exception):
    pass


class Http:
    def __init__(self, token: str | None):
        self.token = token
        self.use_curl = False

    def _headers(self, auth: bool) -> dict:
        h = {"User-Agent": USER_AGENT}
        if auth and self.token:
            h["Authorization"] = "Bearer " + self.token
        return h

    def request(self, method: str, url: str, *, params=None, form=None,
                auth: bool = True, timeout: int = 120) -> tuple[int, bytes]:
        """-> (HTTP status, body). `form` is a list of (name, value) pairs sent
        as multipart/form-data, which is what Harmony expects for POST."""
        if not self.use_curl:
            try:
                import requests
            except ImportError:
                self.use_curl = True
                print("note: python package 'requests' not found, using curl")
            else:
                try:
                    r = requests.request(
                        method, url, params=params, headers=self._headers(auth),
                        files=[(k, (None, v)) for k, v in form] if form else None,
                        timeout=timeout, allow_redirects=True)
                    return r.status_code, r.content
                except requests.exceptions.SSLError as e:
                    self.use_curl = True
                    print("note: Python could not verify the TLS certificate of "
                          f"{url.split('/')[2]} ({type(e).__name__}); switching to "
                          "curl --ssl-no-revoke for the rest of this run "
                          "(verification stays on, only the revocation check is skipped)")
        return self._curl(method, url, params, form, auth, timeout)

    def _curl(self, method, url, params, form, auth, timeout) -> tuple[int, bytes]:
        if params:
            url = url + ("&" if "?" in url else "?") + urlencode(params)
        esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
        # Options go to curl on stdin so the token never appears on a command
        # line or in a file.
        cfg = [f'user-agent = "{esc(USER_AGENT)}"']
        if auth and self.token:
            cfg.append(f'header = "Authorization: Bearer {esc(self.token)}"')
        for k, v in form or []:
            cfg.append(f'form-string = "{esc(k)}={esc(v)}"')
        fd, tmp = tempfile.mkstemp(prefix="tellus_", suffix=".part")
        os.close(fd)
        cmd = ["curl.exe" if os.name == "nt" else "curl", "-sS", "-L",
               "--max-time", str(timeout), "-o", tmp, "-w", "%{http_code}",
               "--config", "-"]
        if os.name == "nt":
            cmd.insert(1, "--ssl-no-revoke")
        if method == "GET" and not form:
            cmd.append("--get")
        cmd.append(url)
        try:
            p = subprocess.run(cmd, input="\n".join(cfg).encode("utf-8"),
                               capture_output=True, timeout=timeout + 30)
            body = Path(tmp).read_bytes()
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        code = p.stdout.decode("ascii", "replace").strip()[-3:]
        if p.returncode != 0 or not code.isdigit():
            raise OSError("curl failed: "
                          + p.stderr.decode("utf-8", "replace").strip()[:300])
        return int(code), body


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def _clean_token(text: str) -> str | None:
    for line in text.splitlines():
        line = line.strip().strip('"').strip("'")
        if line and not line.startswith("#"):
            if line.lower().startswith("bearer "):
                line = line[7:].strip()
            return line or None
    return None


def find_token() -> tuple[str | None, str]:
    """-> (token or None, where it came from). Never prints the token."""
    tok = _clean_token(os.environ.get("EARTHDATA_TOKEN", ""))
    if tok:
        return tok, "environment variable EARTHDATA_TOKEN"
    if TOKEN_FILE.is_file():
        tok = _clean_token(TOKEN_FILE.read_text(encoding="utf-8-sig", errors="replace"))
        if tok:
            return tok, f"file {TOKEN_FILE.name}"
    for name in (".netrc", "_netrc"):
        path = Path.home() / name
        if not path.is_file():
            continue
        try:
            entry = netrc.netrc(str(path)).authenticators("urs.earthdata.nasa.gov")
        except (netrc.NetrcParseError, OSError) as e:
            print(f"note: could not read {path}: {type(e).__name__}")
            continue
        if not entry or not entry[0] or not entry[2]:
            continue
        try:
            import requests
            r = requests.post(URS_TOKEN_URL, auth=(entry[0], entry[2]),
                              headers={"User-Agent": USER_AGENT}, timeout=60)
        except Exception as e:  # noqa: BLE001
            print(f"note: token exchange with Earthdata Login failed "
                  f"({type(e).__name__}); generate a token by hand instead")
            continue
        if r.status_code == 200:
            try:
                tok = _clean_token(str(r.json().get("access_token") or ""))
            except ValueError:
                tok = None
            if tok:
                return tok, f"{path.name} (exchanged for a token at Earthdata Login)"
        print(f"note: Earthdata Login refused the {path.name} credentials "
              f"(HTTP {r.status_code})")
    return None, ""


# ---------------------------------------------------------------------------
# Service helpers
# ---------------------------------------------------------------------------

def read_quota(http: Http) -> float:
    """Fraction (0-1) of the monthly Giovanni compute quota already used."""
    status, body = http.request("GET", QUOTA_URL, timeout=60)
    if status in (401, 403):
        raise AuthError(f"quota endpoint answered HTTP {status}: "
                        + body.decode("utf-8", "replace")[:200])
    if status != 200:
        raise OSError(f"quota endpoint answered HTTP {status}: "
                      + body.decode("utf-8", "replace")[:200])
    return float(json.loads(body)["quota"])


def configured_variables(http: Http) -> set[str] | None:
    try:
        status, body = http.request("GET", CONFIGURED_URL, auth=False, timeout=60)
        if status == 200:
            return set(json.loads(body)["configured_variables"])
        print(f"note: configured-variables list answered HTTP {status}")
    except Exception as e:  # noqa: BLE001
        print(f"note: could not read the configured-variables list ({type(e).__name__})")
    return None


_SPAN_CACHE: dict[str, tuple[str, str]] = {}


def record_span(http: Http, var: dict) -> tuple[str, str, str]:
    """(start, stop, source) of the collection's granules, from the CMR."""
    cid = var["concept_id"]
    if cid not in _SPAN_CACHE:
        try:
            ends = []
            for sort_key, field in (("start_date", "time_start"),
                                    ("-start_date", "time_end")):
                status, body = http.request(
                    "GET", CMR_GRANULES, auth=False, timeout=60,
                    params={"collection_concept_id": cid, "sort_key": sort_key,
                            "page_size": 1})
                entry = json.loads(body)["feed"]["entry"][0]
                ends.append((entry.get(field) or entry["time_start"])[:19])
            _SPAN_CACHE[cid] = (ends[0], ends[1])
        except Exception as e:  # noqa: BLE001
            print(f"note: CMR lookup for {cid} failed ({type(e).__name__}); "
                  "using the record span stored in this script")
            return var["record"][0], var["record"][1], "table"
    return _SPAN_CACHE[cid][0], _SPAN_CACHE[cid][1], "cmr"


def load_regions() -> dict[str, dict]:
    domain = json.loads(DOMAIN_JSON.read_text(encoding="utf-8"))
    out = {}
    for r in domain["regions"]:
        lons = [float(p[0]) for p in r["polygon"]]
        lats = [float(p[1]) for p in r["polygon"]]
        w, s, e, n = min(lons), min(lats), max(lons), max(lats)
        corners = {(w, s), (w, n), (e, s), (e, n)}
        out[r["id"]] = {
            "bbox": [w, s, e, n],
            "is_rectangle": {(float(p[0]), float(p[1])) for p in r["polygon"]} == corners,
        }
    return out


def build_request(var: dict, bbox: list[float], start: str, stop: str) -> tuple[str, list]:
    w, s, e, n = bbox
    url = (f"{HARMONY}/{var['concept_id']}/ogc-api-coverages/1.0.0/collections/"
           "parameter_vars/coverage/rangeset")
    fields = [
        ("forceAsync", "true"),
        ("skipPreview", "true"),
        ("subset", f"lat({s}:{n})"),
        ("subset", f"lon({w}:{e})"),
        ("subset", f'time("{start}":"{stop}")'),
        ("variable", var["giovanni_id"]),
        ("format", "text/csv"),
        ("average", "area"),
    ]
    if var.get("level") is not None:           # none needed today
        fields.append(("subset", f"{var['level'][0]}({var['level'][1]}:{var['level'][1]})"))
    return url, fields


def harmony_error(body: bytes) -> str:
    text = body.decode("utf-8", "replace")
    try:
        j = json.loads(text)
        if isinstance(j, dict):
            return str(j.get("description") or j.get("message") or j.get("error") or text)[:500]
    except ValueError:
        pass
    return text[:500]


def run_job(http: Http, method: str, url: str, fields: list,
            poll_s: float, timeout_s: float) -> dict:
    """Submit, wait, download. -> dict with http_status, content (bytes or
    None), job_id, job_status, job_message, num_input_granules, data_url, error."""
    res = {"http_status": None, "content": None, "job_id": None, "job_status": None,
           "job_message": None, "num_input_granules": None, "data_url": None,
           "error": None}
    if method == "POST":
        status, body = http.request("POST", url, form=fields, timeout=300)
    else:
        status, body = http.request("GET", url, params=fields, timeout=180)
    res["http_status"] = status
    if status in (401, 403):
        raise AuthError(f"Harmony answered HTTP {status}: {harmony_error(body)}")
    if status != 200:
        res["error"] = f"submit failed: {harmony_error(body)}"
        return res
    try:
        job = json.loads(body)
    except ValueError:
        if body.lstrip()[:1] == b"<":
            raise AuthError("Harmony returned an HTML page instead of a job "
                            "(a login page: the token was not accepted)")
        res["error"] = "submit: response is not JSON: " + body[:200].decode("utf-8", "replace")
        return res
    res["job_id"] = job.get("jobID")
    if not res["job_id"]:
        res["error"] = "submit: no jobID in response: " + harmony_error(body)
        return res

    t0 = time.time()
    nudged = False
    while True:
        res["job_status"] = job.get("status")
        res["job_message"] = job.get("message")
        res["num_input_granules"] = job.get("numInputGranules")
        if res["job_status"] in TERMINAL:
            break
        if res["job_status"] in ("previewing", "paused") and not nudged:
            nudged = True
            action = "skip-preview" if res["job_status"] == "previewing" else "resume"
            http.request("GET", f"{HARMONY}/jobs/{res['job_id']}/{action}", timeout=240)
        if time.time() - t0 > timeout_s:
            res["error"] = (f"job {res['job_id']} still '{res['job_status']}' after "
                            f"{int(timeout_s)} s; it keeps running on the server, "
                            "re-run later")
            return res
        print(f"      job {res['job_id']}: {res['job_status']} "
              f"{job.get('progress', 0)}%  ({int(time.time() - t0)} s)", flush=True)
        time.sleep(poll_s)
        status, body = http.request("GET", f"{HARMONY}/jobs/{res['job_id']}",
                                    params={"linktype": "https"}, timeout=240)
        res["http_status"] = status
        if status in (401, 403):
            raise AuthError(f"Harmony answered HTTP {status} while polling")
        if status != 200:
            res["error"] = f"poll failed: {harmony_error(body)}"
            return res
        job = json.loads(body)

    if res["job_status"] != "successful":
        errs = "; ".join(str(e.get("message", e)) for e in job.get("errors", [])[:3])
        res["error"] = f"job {res['job_status']}: {res['job_message']} {errs}".strip()
        return res
    links = [ln["href"] for ln in job.get("links", []) if ln.get("rel") == "data"]
    if len(links) != 1:
        res["error"] = f"expected exactly 1 result file, job lists {len(links)}: {links[:5]}"
        return res
    res["data_url"] = links[0]
    status, body = http.request("GET", links[0], timeout=600)
    res["http_status"] = status
    if status != 200:
        res["error"] = f"download failed: {harmony_error(body)}"
        return res
    head = body.lstrip()[:15].lower()
    if not body.strip():
        res["error"] = "download is empty"
    elif head.startswith(b"<!doctype") or head.startswith(b"<html"):
        res["error"] = "download is an HTML page, not a CSV (login redirect?)"
    else:
        res["content"] = body
    return res


def append_log(record: dict):
    RAW.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=True) + "\n")


def iso_arg(text: str, end: bool) -> str:
    text = text.strip().rstrip("Z")
    if "T" not in text:
        text += "T23:59:59" if end else "T00:00:00"
    dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%S")       # validates
    return text


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def print_table():
    print(f"{'our id':26} {'Giovanni id':46} {'res':8} {'units':22} record (as of 2026-11-14)")
    for vid, v in VARIABLES.items():
        mark = "*" if v["default"] else " "
        print(f"{mark}{vid:25} {v['giovanni_id']:46} {v['resolution']:8} "
              f"{v['units'][:22]:22} {v['record'][0][:7]} .. {v['record'][1][:7]}")
    print("\n* = fetched by default.  Not available in Cloud Giovanni:")
    for vid, why in UNAVAILABLE.items():
        print(f"  {vid}: {why}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variables", help="comma-separated ids from the table, or 'all' "
                    "(default: the ones marked * in --list)")
    ap.add_argument("--regions", help="comma-separated region ids from config/domain.json "
                    "(default: all, most useful first)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the requests only; no token needed, nothing is written")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after this many requests (existing files do not count)")
    ap.add_argument("--list", action="store_true", help="print the variable table and exit")
    ap.add_argument("--start", help="override record start, YYYY-MM-DD (for a cheap test; "
                    "the file then gets a date suffix and is ignored by build_missions)")
    ap.add_argument("--end", help="override record end, YYYY-MM-DD")
    ap.add_argument("--quota-stop", type=float, default=0.90,
                    help="stop when this fraction of the monthly quota is used (default 0.90)")
    ap.add_argument("--skip-quota-check", action="store_true",
                    help="do not call the quota endpoint (at your own risk)")
    ap.add_argument("--no-skip", action="store_true",
                    help="also request regions a product does not cover (e.g. GLDAS over ocean)")
    ap.add_argument("--http-method", choices=("POST", "GET"), default="POST",
                    help="how to submit to Harmony (default POST multipart, as harmony-py does)")
    ap.add_argument("--poll-seconds", type=float, default=5.0)
    ap.add_argument("--job-timeout", type=float, default=1800.0,
                    help="seconds to wait for one job (default 1800)")
    args = ap.parse_args(argv)

    if args.list:
        print_table()
        return 0

    # ---- what to fetch
    if not args.variables:
        var_ids = [v for v, d in VARIABLES.items() if d["default"]]
    elif args.variables.strip().lower() == "all":
        var_ids = list(VARIABLES)
    else:
        var_ids = [v.strip() for v in args.variables.split(",") if v.strip()]
    selected = []
    for vid in var_ids:
        if vid in VARIABLES:
            selected.append(vid)
        elif vid in UNAVAILABLE:
            print(f"SKIP {vid}: not available in Cloud Giovanni - {UNAVAILABLE[vid]}")
        else:
            print(f"SKIP {vid}: unknown id (see --list)")
    regions = load_regions()
    if args.regions:
        region_ids = [r.strip() for r in args.regions.split(",") if r.strip()]
        unknown = [r for r in region_ids if r not in regions]
        if unknown:
            print(f"Unknown region id(s): {', '.join(unknown)}\n"
                  f"Known: {', '.join(regions)}")
            return 1
    else:
        region_ids = [r for r in DEFAULT_REGION_ORDER if r in regions]
        region_ids += [r for r in regions if r not in region_ids]
    if not selected:
        print("Nothing to fetch.")
        return 1

    # ---- credentials (not needed for a dry run)
    token, source = (None, "")
    if not args.dry_run:
        token, source = find_token()
        if not token:
            print(TOKEN_HELP.format(token_file=TOKEN_FILE))
            return 2
        print(f"Earthdata Login token: from {source}")
    http = Http(token)

    configured = configured_variables(http)
    if configured is not None:
        for vid in list(selected):
            gid = VARIABLES[vid]["giovanni_id"]
            if gid not in configured:
                print(f"SKIP {vid}: {gid} is no longer in the Giovanni "
                      "configured-variables list")
                selected.remove(vid)

    start_override = iso_arg(args.start, False) if args.start else None
    end_override = iso_arg(args.end, True) if args.end else None
    suffix = ""
    if start_override or end_override:
        suffix = "__%s-%s" % ((start_override or "start")[:10].replace("-", ""),
                              (end_override or "end")[:10].replace("-", ""))

    n_req = n_saved = n_skipped = n_failed = consecutive_failures = 0
    stop_reason = None
    try:
        for vid in selected:
            var = VARIABLES[vid]
            rec_start, rec_stop, span_src = record_span(http, var)
            start = start_override or rec_start
            stop = end_override or rec_stop
            print(f"\n== {vid}  <-  {var['giovanni_id']}  [{var['resolution']}, "
                  f"{var['units']}]  {start} .. {stop} (span from {span_src})")
            shown_sample = False
            for rid in region_ids:
                out = RAW / vid / f"{rid}{suffix}.csv"
                rel = out.relative_to(ROOT).as_posix()
                if rid in var.get("skip_regions", ()) and not args.no_skip:
                    print(f"   - {rid}: not covered by this product, skipped "
                          "(--no-skip to request anyway)")
                    continue
                if out.exists() and out.stat().st_size > 0:
                    n_skipped += 1
                    print(f"   - {rid}: already have {rel}")
                    continue
                if args.limit is not None and n_req >= args.limit:
                    stop_reason = f"--limit {args.limit} reached"
                    raise StopIteration
                bbox = regions[rid]["bbox"]
                url, fields = build_request(var, bbox, start, stop)
                get_url = url + "?" + urlencode(fields)
                n_req += 1
                note = "" if regions[rid]["is_rectangle"] else "  (bounding box of a non-rectangular polygon)"
                print(f"   [{n_req}] {rid}: bbox W={bbox[0]} S={bbox[1]} E={bbox[2]} N={bbox[3]}{note}")
                if args.dry_run:
                    print(f"      {args.http_method} {url}")
                    print("      fields: " + "  ".join(f"{k}={v}" for k, v in fields))
                    print(f"      as one URL: {get_url}")
                    print(f"      -> {rel}")
                    continue

                quota = None
                if not args.skip_quota_check:
                    try:
                        quota = read_quota(http)
                    except AuthError:
                        raise
                    except Exception as e:  # noqa: BLE001
                        stop_reason = (f"could not read the quota ({e}); stopping to be "
                                       "safe (--skip-quota-check overrides)")
                        n_req -= 1
                        raise StopIteration
                    if quota >= args.quota_stop:
                        stop_reason = (f"Giovanni monthly quota used: {quota:.1%} >= "
                                       f"{args.quota_stop:.0%}; stopping before it runs out")
                        n_req -= 1
                        raise StopIteration
                    print(f"      quota used so far this month: {quota:.2%}")

                t0 = time.time()
                try:
                    res = run_job(http, args.http_method, url, fields,
                                  args.poll_seconds, args.job_timeout)
                except AuthError:
                    raise
                except Exception as e:  # noqa: BLE001
                    res = {"http_status": None, "content": None, "job_id": None,
                           "job_status": None, "job_message": None,
                           "num_input_granules": None, "data_url": None,
                           "error": f"{type(e).__name__}: {str(e)[:300]}"}
                record = {
                    "variable": vid, "giovanni_id": var["giovanni_id"],
                    "region": rid, "bbox_wsen": bbox,
                    "time_start": start, "time_stop": stop,
                    "method": args.http_method, "request_url": get_url,
                    "utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                    "http_status": res["http_status"], "bytes": 0,
                    "job_id": res["job_id"], "job_status": res["job_status"],
                    "job_message": res["job_message"],
                    "num_input_granules": res["num_input_granules"],
                    "data_url": res["data_url"], "quota_before": quota,
                    "seconds": round(time.time() - t0, 1), "file": None,
                    "error": res["error"],
                }
                if res["content"] is not None:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    tmp = out.with_suffix(".part")
                    tmp.write_bytes(res["content"])          # raw, unchanged
                    os.replace(tmp, out)
                    record.update(bytes=len(res["content"]), file=rel,
                                  sha256=hashlib.sha256(res["content"]).hexdigest())
                    n_saved += 1
                    consecutive_failures = 0
                    print(f"      saved {rel} ({len(res['content'])} bytes, "
                          f"{record['seconds']} s)")
                    msg = (res["job_message"] or "").lower()
                    if "limited" in msg or "truncat" in msg:
                        print("      WARNING, Harmony says the job was limited: "
                              f"{res['job_message']}")
                    if not shown_sample:
                        shown_sample = True
                        print("      first lines of the file as returned:")
                        for ln in res["content"][:1500].decode("utf-8", "replace").splitlines()[:18]:
                            print("        | " + ln)
                else:
                    n_failed += 1
                    consecutive_failures += 1
                    print(f"      FAILED: {res['error']}")
                append_log(record)
                if consecutive_failures >= 3:
                    stop_reason = "3 requests in a row failed; stopping to protect the quota"
                    raise StopIteration
    except StopIteration:
        pass
    except AuthError as e:
        print(f"\nAuthentication problem: {e}")
        print("The token is missing, expired or not accepted. Generate a new one at "
              "https://urs.earthdata.nasa.gov (Generate Token) and, if needed, approve "
              "'NASA GESDISC DATA ARCHIVE' under Applications -> Authorized Apps.")
        return 2
    except KeyboardInterrupt:
        stop_reason = "interrupted"

    if stop_reason:
        print(f"\nStopped: {stop_reason}")
    if args.dry_run:
        print(f"\nDry run: {n_req} request(s) would be sent, {n_skipped} file(s) already "
              "present. Nothing was downloaded or written.")
        return 0
    print(f"\nDone: {n_saved} saved, {n_failed} failed, {n_skipped} already present. "
          f"Log: {LOG.relative_to(ROOT).as_posix()}")
    if stop_reason and "quota" in stop_reason:
        return 3
    return 1 if n_failed and not n_saved else 0


if __name__ == "__main__":
    sys.exit(main())
