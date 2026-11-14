"""GPCP V2.3 adapter — observed precipitation for the model-vs-observed panel."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from config_loader import load_config  # noqa: E402

CFG = load_config()


def load_gpcp_domain(path: Path | None = None) -> dict:
    """Open the PSL GPCP file, subset to the Tellus domain.

    Returns {"lats", "lons", "months" (YYYYMM), "data" [n_lat, n_lon, n_months]},
    with the file's native units preserved in "units".
    """
    path = path or ROOT / "data" / "raw" / "gpcp" / "precip.mon.mean.nc"
    # decode_times=False: the file's time_bnds units string is non-CF-standard
    ds = xr.open_dataset(path, decode_times=False)
    da = ds["precip"]
    d = CFG["domain"]
    sub = da.sel(lat=slice(d["lat_min"], d["lat_max"]),
                 lon=slice(d["lon_min"], d["lon_max"]))

    lats = sub["lat"].values.astype(float)
    lons = sub["lon"].values.astype(float)
    # time = days since 1800-01-01 in the standard Gregorian calendar
    time_units = ds["time"].attrs.get("units", "days since 1800-01-01 00:00:00")
    epoch = np.datetime64("1800-01-01", "D")
    days = sub["time"].values.astype(float)
    dates = epoch + days.astype("timedelta64[D]")
    months = np.array([int(str(x)[:7].replace("-", "")) for x in dates], dtype=int)
    data = np.asarray(sub.values, dtype=float).transpose(1, 2, 0)  # -> [lat, lon, time]
    units = str(da.attrs.get("units", "unknown"))
    long_name = str(da.attrs.get("long_name", "GPCP precipitation"))
    ds.close()
    return {"lats": lats, "lons": lons, "months": months, "data": data,
            "units": units, "long_name": long_name}
