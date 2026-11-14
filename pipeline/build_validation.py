"""Build frontend/public/data/validation.json for the "Check our work" page.

Every check compares a number computed by OUR pipeline (pipeline/stats.py,
persistence-adjusted Mann-Kendall / Sen / OLS) from the shipped static assets
(presets.json, missions.json, gpcp_series.json) with a published or
independent reference value.

PRE-REGISTRATION: the periods, regions and pass/partial/fail rules below were
written down from the reference sources BEFORE our numbers were looked at,
and are not tuned afterwards. The rule text shipped to the page is generated
from the same constants that decide the status, so the two cannot drift.

Generic rule shape ("range rule"):
    pass    our value lies inside the reference range [lo, hi]
    partial our value is outside the range but within `tol` (a fraction of the
            nearest range edge) of it, and has the same sign
    fail    anything else

Deterministic: no network access, no wall-clock values, seeded bootstrap.
The only external inputs are the three independent global-temperature
series embedded below (downloaded 2026-11-15 from the URLs in SOURCES).

Run:  python pipeline/build_validation.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from stats import ols, sen_slope, trend_result  # noqa: E402

DATA = ROOT / "frontend" / "public" / "data"
OUT = DATA / "validation.json"
VERIFIED_ON = "2026-11-15"

# --------------------------------------------------------------------------
# Independent global-mean temperature anomalies (deg C), annual, 1981-2025.
# GISTEMP v4 land-ocean index (J-D column), NOAAGlobalTemp via NCEI Climate at
# a Glance, HadCRUT 5.0.2.0 analysis summary series. Downloaded 2026-11-15.
# --------------------------------------------------------------------------
GISTEMP = {1981: 0.32, 1982: 0.14, 1983: 0.31, 1984: 0.16, 1985: 0.12, 1986: 0.18, 1987: 0.32, 1988: 0.39, 1989: 0.27, 1990: 0.45, 1991: 0.41, 1992: 0.22, 1993: 0.23, 1994: 0.31, 1995: 0.44, 1996: 0.33, 1997: 0.46, 1998: 0.61, 1999: 0.38, 2000: 0.39, 2001: 0.53, 2002: 0.63, 2003: 0.61, 2004: 0.53, 2005: 0.68, 2006: 0.64, 2007: 0.66, 2008: 0.54, 2009: 0.66, 2010: 0.72, 2011: 0.61, 2012: 0.64, 2013: 0.67, 2014: 0.75, 2015: 0.9, 2016: 1.01, 2017: 0.91, 2018: 0.85, 2019: 0.98, 2020: 1.01, 2021: 0.85, 2022: 0.89, 2023: 1.17, 2024: 1.28, 2025: 1.19}
NOAAGT = {1981: 0.33, 1982: 0.15, 1983: 0.32, 1984: 0.17, 1985: 0.15, 1986: 0.22, 1987: 0.33, 1988: 0.38, 1989: 0.26, 1990: 0.42, 1991: 0.41, 1992: 0.23, 1993: 0.26, 1994: 0.32, 1995: 0.46, 1996: 0.34, 1997: 0.48, 1998: 0.61, 1999: 0.4, 2000: 0.4, 2001: 0.53, 2002: 0.59, 2003: 0.6, 2004: 0.54, 2005: 0.67, 2006: 0.63, 2007: 0.62, 2008: 0.53, 2009: 0.65, 2010: 0.71, 2011: 0.6, 2012: 0.63, 2013: 0.66, 2014: 0.73, 2015: 0.88, 2016: 1.0, 2017: 0.93, 2018: 0.87, 2019: 0.99, 2020: 1.01, 2021: 0.86, 2022: 0.89, 2023: 1.17, 2024: 1.26, 2025: 1.12}
HADCRUT5 = {1981: 0.25, 1982: 0.0343, 1983: 0.2238, 1984: 0.048, 1985: 0.0497, 1986: 0.0957, 1987: 0.243, 1988: 0.2822, 1989: 0.1793, 1990: 0.3606, 1991: 0.3389, 1992: 0.1249, 1993: 0.1657, 1994: 0.2335, 1995: 0.3769, 1996: 0.2767, 1997: 0.4223, 1998: 0.5773, 1999: 0.3245, 2000: 0.3311, 2001: 0.4893, 2002: 0.5435, 2003: 0.5442, 2004: 0.4674, 2005: 0.6069, 2006: 0.5726, 2007: 0.5917, 2008: 0.4656, 2009: 0.5968, 2010: 0.6804, 2011: 0.5377, 2012: 0.5776, 2013: 0.6236, 2014: 0.6729, 2015: 0.8251, 2016: 0.9329, 2017: 0.8452, 2018: 0.7627, 2019: 0.8911, 2020: 0.9229, 2021: 0.7619, 2022: 0.8013, 2023: 1.1003, 2024: 1.1808, 2025: 1.1903}

SRC = {
    "gistemp": {
        "citation": "NASA GISS, GISTEMP v4 global land-ocean temperature index (Lenssen et al. 2019, J. Geophys. Res. Atmos., doi:10.1029/2018JD029522)",
        "url": "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
        "quote": "Annual (J-D) global means, 1981-2025, downloaded 2026-11-15.",
    },
    "noaagt": {
        "citation": "NOAA NCEI, NOAAGlobalTemp, Climate at a Glance: global land and ocean annual anomalies",
        "url": "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/tavg/land_ocean/12/12/1981-2025/data.csv",
        "quote": "Annual departures from the 1901-2000 average, 1981-2025, downloaded 2026-11-15.",
    },
    "hadcrut5": {
        "citation": "UK Met Office Hadley Centre / UEA CRU, HadCRUT 5.0.2.0 analysis summary series, global annual (Morice et al. 2021, J. Geophys. Res. Atmos., doi:10.1029/2019JD032361)",
        "url": "https://www.metoffice.gov.uk/hadobs/hadcrut5/data/HadCRUT.5.0.2.0/analysis/diagnostics/HadCRUT.5.0.2.0.analysis.summary_series.global.annual.csv",
        "quote": "Annual global anomaly, 1981-2025, downloaded 2026-11-15.",
    },
    "rantanen": {
        "citation": "Rantanen, M. et al. (2022). The Arctic has warmed nearly four times faster than the globe since 1979. Communications Earth & Environment 3, 168",
        "url": "https://doi.org/10.1038/s43247-022-00498-3",
        "quote": "\"... we arrive at AA43 ... of 3.8 for the latest 43-year period of 1979-2021. The individual AA43 values range from 3.7 in ERA5 to 4.1 in BEST\"; \"The Arctic is defined as the area north of 66.5N\"; multi-dataset trends \"0.73 C decade-1\" (Arctic) and \"0.19 C decade-1\" (globe). Read in the full text (open-access PDF, Zenodo record 8063478).",
    },
    "knmi": {
        "citation": "KNMI (Royal Netherlands Meteorological Institute), Klimaatdashboard (climate dashboard) news item",
        "url": "https://www.knmi.nl/over-het-knmi/nieuws/klimaatdashboard",
        "quote": "\"De jaartemperatuur in De Bilt is tussen 1901 en 2020 met ruim 2 °C gestegen\" (the annual temperature in De Bilt rose by a good 2 °C between 1901 and 2020).",
    },
    "krotkov": {
        "citation": "Krotkov, N. A. et al. (2016). Aura OMI observations of regional SO2 and NO2 pollution changes from 2005 to 2015. Atmospheric Chemistry and Physics 16, 4605-4629",
        "url": "https://doi.org/10.5194/acp-16-4605-2016",
        "quote": "India's SO2 and NO2 levels are \"increasing by more than 100 and 50 %, respectively, from 2005 to 2015.\" (abstract; the abstract does not define the India region).",
    },
    "menemenlis": {
        "citation": "Menemenlis, S., Vecchi, G. A., Yang, W., Fueglistaler, S., Raghuraman, S. P. (2025). Consequential differences in satellite-era sea surface temperature trends across datasets. Nature Climate Change 15, 897-903",
        "url": "https://doi.org/10.1038/s41558-025-02362-6",
        "quote": "\"... trends in four widely used SST datasets show first-order differences, with 1982-2024 60° S to 60° N trends ranging from 0.108 to 0.184 °C per decade.\"",
    },
    "ncei_gsom": {
        "citation": "NOAA NCEI, Global Summary of the Month v1.0 (station De Bilt), via Climate Data Online",
        "url": "https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-monthly",
        "quote": "Station monthly mean temperature aggregated to calendar years in missions.json (NCEI_GSOM_TAVG).",
    },
    "merra2": {
        "citation": "NASA POWER monthly regional API, source-native MERRA-2 grid (Gelaro et al. 2017, J. Climate 30, 5419-5454)",
        "url": "https://power.larc.nasa.gov/docs/",
        "quote": "T2M and PRECTOTCORR, 1981-2025, area-weighted regional means (presets.json).",
    },
    "gpcp": {
        "citation": "Adler, R. F. et al. (2018). The Global Precipitation Climatology Project (GPCP) Monthly Analysis (New Version 2.3). Atmosphere 9(4), 138",
        "url": "https://doi.org/10.3390/atmos9040138",
        "quote": "GPCP V2.3 combined precipitation, regional annual means (gpcp_series.json, NOAA PSL copy).",
    },
    "imerg": {
        "citation": "Huffman, G. J. et al. GPM IMERG Final Precipitation L3 1 month 0.1 degree x 0.1 degree V07 (GPM_3IMERGM), NASA GES DISC",
        "url": "https://disc.gsfc.nasa.gov/datasets/GPM_3IMERGM_07/summary",
        "quote": "Regional annual totals from Giovanni area averages (missions.json, IMERG_PRECIP).",
    },
    "acker": {
        "citation": "Acker, J. G., McMahon, E., Shen, S., Hearty, T., Casey, N. (2009). Time-Series Analysis of Remotely-Sensed SeaWiFS Chlorophyll in River-Influenced Coastal Regions. EARSeL eProceedings 8(2). NASA NTRS 20090042747",
        "url": "https://ntrs.nasa.gov/citations/20090042747",
        "quote": "Nine river-influenced marine regions; \"major river systems in regions with relatively low human impact showed no significant trends\"; most systems with clear human impact showed significant negative trends, the exception being the Pearl River (positive). (paraphrased from the NTRS abstract; the page does not state the study period).",
    },
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


PRESETS = load("presets.json")
MISSIONS = load("missions.json")
GPCP = load("gpcp_series.json")


def clean(x):
    """JSON-safe, rounded (4 significant digits kept generously)."""
    if x is None:
        return None
    if isinstance(x, (np.floating, float)):
        x = float(x)
        if not math.isfinite(x):
            return None
        return float(f"{x:.6g}")
    return x


def window(years, values, y0, y1):
    ys, vs = [], []
    for y, v in zip(years, values):
        if y0 <= y <= y1 and v is not None and np.isfinite(v):
            ys.append(y)
            vs.append(float(v))
    return np.array(ys, dtype=float), np.array(vs, dtype=float)


def series_dict_window(d: dict, y0: int, y1: int):
    ys = sorted(k for k in d if y0 <= k <= y1)
    return np.array(ys, dtype=float), np.array([d[k] for k in ys], dtype=float)


def range_rule(value, lo, hi, tol):
    """pass inside [lo, hi]; partial if same sign and within tol of nearest edge."""
    if lo <= value <= hi:
        return "pass"
    edge = lo if value < lo else hi
    if value * edge > 0 and abs(value - edge) <= tol * abs(edge):
        return "partial"
    return "fail"


def decadal(tr):
    """Sen slope and persistence-adjusted CI, per decade."""
    return (tr["sen_slope"] * 10, tr["ci_adj_low"] * 10, tr["ci_adj_high"] * 10)


def pearson_detrended(ya, a, yb, b):
    common = sorted(set(ya.astype(int)) & set(yb.astype(int)))
    ia = {int(y): v for y, v in zip(ya, a)}
    ib = {int(y): v for y, v in zip(yb, b)}
    x = np.array([ia[y] for y in common])
    z = np.array([ib[y] for y in common])
    t = np.array(common, dtype=float)
    rx = x - np.polyval(np.polyfit(t, x, 1), t)
    rz = z - np.polyval(np.polyfit(t, z, 1), t)
    return float(np.corrcoef(rx, rz)[0, 1])


# --------------------------------------------------------------------------
# CASE 1: global mean temperature trend (MERRA-2 T2M vs three global indices)
#   Period 1981-2025 (MERRA-2 record start to last full year).
#   Reference range = min..max of the Sen slopes of GISTEMP, NOAAGlobalTemp,
#   HadCRUT5 over the same years, computed with the same engine.
#   Rule: range rule, tol 25 %.
# --------------------------------------------------------------------------
TOL_GLOBAL = 0.25


def case_global_temp():
    reg = PRESETS["T2M"]["annual"]["whole-earth"]
    ys, vs = window(reg["years"], reg["values"], 1981, 2025)
    ours = trend_result(ys, vs)
    o_v, o_lo, o_hi = decadal(ours)
    refs = {}
    for key, d in (("GISTEMP v4", GISTEMP), ("NOAAGlobalTemp", NOAAGT), ("HadCRUT 5.0.2.0", HADCRUT5)):
        yr, vr = series_dict_window(d, 1981, 2025)
        refs[key] = decadal(trend_result(yr, vr))
    lo = min(v[0] for v in refs.values())
    hi = max(v[0] for v in refs.values())
    status = range_rule(o_v, lo, hi, TOL_GLOBAL)
    parts = ", ".join(f"{k} {v[0]:.3f}" for k, v in refs.items())
    expl = {
        "pass": "MERRA-2 2 m air temperature reproduces the global warming rate of the three independent surface-temperature indices.",
        "partial": "MERRA-2 shows clear warming in the same direction but its rate sits just outside the range of the three indices.",
        "fail": "MERRA-2's global rate is not close to the independent indices.",
    }[status]
    expl += (f" Reference indices (Sen slope, deg C/decade): {parts}. "
             "Not a like-for-like quantity: MERRA-2 T2M is air temperature over land and ocean "
             "from a reanalysis, while the indices blend land air and sea-surface temperature.")
    return {
        "id": "global-warming-rate",
        "title": "Global warming rate, 1981-2025",
        "question": "Does our global-mean temperature trend match NASA, NOAA and the Met Office?",
        "kind": "independent-data",
        "region": "Whole Earth (area-weighted)",
        "period_ours": "1981-2025", "period_reference": "1981-2025",
        "units": "°C per decade", "decimals": 3,
        "our": {"label": "MERRA-2 2 m air temperature (Sen slope, 95% CI persistence-adjusted)",
                "value": clean(o_v), "ci_low": clean(o_lo), "ci_high": clean(o_hi)},
        "reference": {"label": "Range of GISTEMP v4, NOAAGlobalTemp and HadCRUT5 (same Sen method)",
                      "value": clean((lo + hi) / 2), "low": clean(lo), "high": clean(hi),
                      "items": {k: clean(v[0]) for k, v in refs.items()}},
        "rule": (f"Pass if our trend lies inside the range spanned by the three reference indices; "
                 f"partial if outside it but same sign and within {int(TOL_GLOBAL*100)}% of the nearest edge; fail otherwise."),
        "status": status,
        "explanation": expl,
        "sources": [SRC["merra2"], SRC["gistemp"], SRC["noaagt"], SRC["hadcrut5"]],
    }


# --------------------------------------------------------------------------
# CASE 2: Arctic amplification (Rantanen et al. 2022)
#   Published: AA = ratio of OLS trends, Arctic (north of 66.5N) / globe,
#   1979-2021: 3.8 multi-dataset, individual datasets 3.7-4.1.
#   Ours: MERRA-2 T2M ratio of OLS slopes, arctic region (>66.5N) / whole-earth,
#   1981-2021 (MERRA-2 here starts 1981; the 1979-80 years are unavailable).
#   Interval: seeded paired-year bootstrap (4000 resamples).
#   Rule: range rule on [3.7, 4.1], tol 25 %.
# --------------------------------------------------------------------------
TOL_ARCTIC = 0.25
AA_RANGE = (3.7, 4.1)


def case_arctic():
    a = PRESETS["T2M"]["annual"]["arctic"]
    g = PRESETS["T2M"]["annual"]["whole-earth"]
    ya, va = window(a["years"], a["values"], 1981, 2021)
    yg, vg = window(g["years"], g["values"], 1981, 2021)
    assert list(ya) == list(yg)
    sa, sg = ols(ya, va).slope, ols(yg, vg).slope
    ratio = sa / sg
    rng = np.random.default_rng(20261115)
    n = ya.size
    boots = []
    for _ in range(4000):
        idx = rng.integers(0, n, n)
        if np.unique(ya[idx]).size < 5:
            continue
        boots.append(ols(ya[idx], va[idx]).slope / ols(yg[idx], vg[idx]).slope)
    lo_ci, hi_ci = np.percentile(boots, [2.5, 97.5])
    status = range_rule(ratio, AA_RANGE[0], AA_RANGE[1], TOL_ARCTIC)
    expl = {
        "pass": "The Arctic (north of 66.5 deg N) warms about four times as fast as the globe in our data, as Rantanen et al. report.",
        "partial": "Our ratio shows strong Arctic amplification but lies outside the published 3.7 to 4.1 range.",
        "fail": "Our Arctic-to-global ratio is not close to the published value.",
    }[status]
    expl += (f" Our Arctic trend is {sa*10:.2f} and global trend {sg*10:.2f} deg C/decade "
             "(published: 0.73 and 0.19 over 1979-2021). The interval is a bootstrap over years. "
             "Caveats: our record starts in 1981, not 1979, and a reanalysis differs from the "
             "observational datasets used in the paper.")
    return {
        "id": "arctic-amplification",
        "title": "Arctic amplification",
        "question": "Is the Arctic warming about four times as fast as the whole planet?",
        "kind": "literature",
        "region": "Arctic (north of 66.5 deg N) vs Whole Earth",
        "period_ours": "1981-2021", "period_reference": "1979-2021",
        "units": "ratio (Arctic trend / global trend)", "decimals": 2,
        "our": {"label": "MERRA-2 2 m temperature, ratio of OLS slopes (95% bootstrap interval)",
                "value": clean(ratio), "ci_low": clean(lo_ci), "ci_high": clean(hi_ci)},
        "reference": {"label": "Rantanen et al. 2022: 3.8 (individual datasets 3.7 to 4.1)",
                      "value": 3.8, "low": AA_RANGE[0], "high": AA_RANGE[1]},
        "rule": (f"Pass if our ratio is inside the published range {AA_RANGE[0]} to {AA_RANGE[1]}; "
                 f"partial if outside it but within {int(TOL_ARCTIC*100)}% of the nearest edge; fail otherwise."),
        "status": status,
        "explanation": expl,
        "sources": [SRC["rantanen"], SRC["merra2"]],
    }


# --------------------------------------------------------------------------
# CASE 3: De Bilt station warming vs KNMI statement
#   KNMI: annual temperature in De Bilt rose by "ruim 2 C" (a good 2 C) 1901-2020.
#   We read "ruim 2" as 2.0 to 2.5 C (our interpretation, stated on the page).
#   Ours: Sen slope of the NCEI GSOM De Bilt annual series 1901-2020 x 119 years.
#   Rule: range rule on [2.0, 2.5], tol 15 % (about 0.3 C).
# --------------------------------------------------------------------------
TOL_DEBILT = 0.15
DEBILT_RANGE = (2.0, 2.5)


def debilt_series():
    d = MISSIONS["NCEI_GSOM_TAVG"]["annual"]["western-europe"]
    return d["years"], d["values"]


def case_debilt_knmi():
    yrs, vals = debilt_series()
    ys, vs = window(yrs, vals, 1901, 2020)
    tr = trend_result(ys, vs)
    span = 2020 - 1901
    v, lo, hi = tr["sen_slope"] * span, tr["ci_adj_low"] * span, tr["ci_adj_high"] * span
    status = range_rule(v, DEBILT_RANGE[0], DEBILT_RANGE[1], TOL_DEBILT)
    expl = {
        "pass": "The NOAA station record for De Bilt gives the same century-scale warming that KNMI reports for the same station.",
        "partial": "Our station warming is close to, but outside, the range we read from KNMI's statement.",
        "fail": "Our station warming does not match KNMI's statement.",
    }[status]
    expl += (f" Our trend is {tr['sen_slope']*10:.3f} deg C/decade over {tr['n']} valid years. "
             "KNMI states a total rise (\"ruim 2\" = a good 2 deg C) fitted by its own trend method; "
             "reading that as 2.0 to 2.5 deg C is our interpretation, and Sen's slope is not KNMI's method.")
    return {
        "id": "de-bilt-century-warming",
        "title": "De Bilt century warming vs KNMI",
        "question": "Does the station record we ship show the century warming KNMI reports for De Bilt?",
        "kind": "literature",
        "region": "De Bilt station, Netherlands",
        "period_ours": "1901-2020", "period_reference": "1901-2020",
        "units": "°C total rise over 1901-2020", "decimals": 2,
        "our": {"label": "NCEI GSOM De Bilt annual mean temperature (Sen slope x 119 years, 95% CI persistence-adjusted)",
                "value": clean(v), "ci_low": clean(lo), "ci_high": clean(hi)},
        "reference": {"label": "KNMI: \"ruim 2 °C\" (read as 2.0 to 2.5)",
                      "value": 2.25, "low": DEBILT_RANGE[0], "high": DEBILT_RANGE[1]},
        "rule": (f"Pass if our total rise is inside {DEBILT_RANGE[0]} to {DEBILT_RANGE[1]} deg C; "
                 f"partial if outside but within {int(TOL_DEBILT*100)}% of the nearest edge; fail otherwise."),
        "status": status,
        "explanation": expl,
        "sources": [SRC["ncei_gsom"], SRC["knmi"]],
    }


# --------------------------------------------------------------------------
# CASE 4: station vs reanalysis (De Bilt vs MERRA-2 western Europe), 1981-2025
#   Rule: pass if the two persistence-adjusted 95% intervals overlap AND the
#   Sen slopes agree within 30 % of the station value; partial if the
#   intervals overlap but slopes differ by more than 30 %; fail if the
#   intervals do not overlap.
# --------------------------------------------------------------------------
TOL_STATION = 0.30


def case_station_vs_reanalysis():
    yrs, vals = debilt_series()
    ys, vs = window(yrs, vals, 1981, 2025)
    st = trend_result(ys, vs)
    reg = PRESETS["T2M"]["annual"]["western-europe"]
    yr, vr = window(reg["years"], reg["values"], 1981, 2025)
    mr = trend_result(yr, vr)
    s_v, s_lo, s_hi = decadal(st)
    m_v, m_lo, m_hi = decadal(mr)
    overlap = max(s_lo, m_lo) <= min(s_hi, m_hi)
    close = abs(m_v - s_v) <= TOL_STATION * abs(s_v)
    status = "pass" if (overlap and close) else ("partial" if overlap else "fail")
    r = pearson_detrended(ys, vs, yr, vr)
    expl = {
        "pass": "The reanalysis box average and the single station warm at nearly the same rate, and year-to-year changes agree.",
        "partial": "Both show warming and their uncertainty ranges overlap, but the rates differ by more than 30%.",
        "fail": "The station and reanalysis trends are statistically inconsistent.",
    }[status]
    expl += (f" Detrended year-to-year correlation r = {r:.2f}. The comparison is imperfect by design: one station "
             "(De Bilt) against a 20 x 35 degree box of 0.5 x 0.625 degree cells, which includes the Atlantic coast and mountains.")
    return {
        "id": "station-vs-reanalysis",
        "title": "Station ground truth vs reanalysis",
        "question": "Does the satellite-era model data agree with a thermometer on the ground?",
        "kind": "independent-data",
        "region": "Western Europe box (MERRA-2) vs De Bilt station",
        "period_ours": "1981-2025", "period_reference": "1981-2025",
        "units": "°C per decade", "decimals": 3,
        "our": {"label": "MERRA-2 T2M, Western Europe box (Sen slope, 95% CI persistence-adjusted)",
                "value": clean(m_v), "ci_low": clean(m_lo), "ci_high": clean(m_hi)},
        "reference": {"label": "De Bilt station, NCEI GSOM (Sen slope, 95% CI persistence-adjusted)",
                      "value": clean(s_v), "low": clean(s_lo), "high": clean(s_hi)},
        "rule": (f"Pass if the two 95% intervals overlap and the slopes differ by at most {int(TOL_STATION*100)}% "
                 "of the station slope; partial if the intervals overlap but the slopes differ by more; "
                 "fail if the intervals do not overlap."),
        "status": status,
        "explanation": expl,
        "sources": [SRC["merra2"], SRC["ncei_gsom"]],
    }


# --------------------------------------------------------------------------
# CASE 5: India NO2 rise, 2005-2015 (Krotkov et al. 2016)
#   Published: India NO2 increased by "more than 50 %", 2005-2015.
#   Ours: OMI_NO2 Indo-Gangetic Plain annual means; Sen slope x 10 yr divided
#   by the Sen-line value at 2005 (median of y - slope*x evaluated at 2005).
#   Rule: pass if >= +50 %; partial if between +25 % and +50 %; fail otherwise.
# --------------------------------------------------------------------------
NO2_PASS, NO2_PARTIAL = 50.0, 25.0


def pct_change_sen(ys, vs, y_start, y_end):
    tr = trend_result(ys, vs)
    slope = tr["sen_slope"]
    base = float(np.median(vs - slope * ys) + slope * y_start)
    f = 100.0 * (y_end - y_start) / base
    return slope * f, tr["ci_adj_low"] * f, tr["ci_adj_high"] * f, base, tr


def case_india_no2():
    reg = MISSIONS["OMI_NO2"]["annual"]["indo-gangetic-plain"]
    ys, vs = window(reg["years"], reg["values"], 2005, 2015)
    pct, lo, hi, base, tr = pct_change_sen(ys, vs, 2005, 2015)
    status = "pass" if pct >= NO2_PASS else ("partial" if pct >= NO2_PARTIAL else "fail")
    expl = {
        "pass": "OMI NO2 over the Indo-Gangetic Plain rose by at least the 50% that Krotkov et al. report for India.",
        "partial": "NO2 rose over the Indo-Gangetic Plain, but by less than the published 50%, as expected for a broad regional average.",
        "fail": "Our regional NO2 change does not show the published increase.",
    }[status]
    expl += (f" Sen-line start value {base:.2f} x10^15 molec/cm2 in 2005; trend p (persistence-adjusted) = {tr['mk_p_adj']:.3f}. "
             "Krotkov's abstract does not define its India region and its largest increases are at coal-power hotspots, "
             "so a whole-plain average is a diluted version of the same signal. Only 11 annual points are used, which is short.")
    return {
        "id": "india-no2-2005-2015",
        "title": "India NO2 rise, 2005-2015",
        "question": "Did tropospheric NO2 over northern India rise by more than half in a decade?",
        "kind": "literature",
        "region": "Indo-Gangetic Plain",
        "period_ours": "2005-2015", "period_reference": "2005-2015",
        "units": "% change over the decade", "decimals": 0,
        "our": {"label": "OMI NO2 (Sen slope x 10 years / 2005 level, 95% CI persistence-adjusted)",
                "value": clean(pct), "ci_low": clean(lo), "ci_high": clean(hi)},
        "reference": {"label": "Krotkov et al. 2016: India NO2 \"more than 50 %\"",
                      "value": 50, "low": 50, "high": None},
        "rule": (f"Pass if our change is at least +{int(NO2_PASS)}%; partial if it is between +{int(NO2_PARTIAL)}% and "
                 f"+{int(NO2_PASS)}% (same sign, at least half the published size); fail otherwise."),
        "status": status,
        "explanation": expl,
        "sources": [{**SRC["krotkov"]}, {
            "citation": "NASA GES DISC, OMI/Aura NO2 Cloud-Screened Total and Tropospheric Column Daily L3 0.25 deg (OMNO2d v003), via Giovanni area averages",
            "url": "https://disc.gsfc.nasa.gov/datasets/OMNO2d_003/summary",
            "quote": "Regional annual means in missions.json (OMI_NO2).",
        }],
    }


# --------------------------------------------------------------------------
# CASE 6: global ocean surface warming (OISST vs Menemenlis et al. 2025)
#   Published: 1982-2024, 60S-60N, four SST datasets: 0.108-0.184 C/decade.
#   Ours: KNMI Climate Explorer OISST v2 whole-earth box mean, 1982-2022 (the
#   shipped series ends 2022).
#   Rule: range rule on [0.108, 0.184], tol 25 %.
# --------------------------------------------------------------------------
TOL_SST = 0.25
SST_RANGE = (0.108, 0.184)


def case_sst():
    reg = MISSIONS["KNMI_OISSTV2_SST"]["annual"]["whole-earth"]
    ys, vs = window(reg["years"], reg["values"], 1982, 2022)
    tr = trend_result(ys, vs)
    v, lo, hi = decadal(tr)
    status = range_rule(v, SST_RANGE[0], SST_RANGE[1], TOL_SST)
    expl = {
        "pass": "Our satellite-era sea-surface warming rate falls inside the spread between published SST datasets.",
        "partial": "Our SST warming is positive and close to, but outside, the published spread of SST datasets.",
        "fail": "Our SST warming rate is not consistent with the published spread of SST datasets.",
    }[status]
    expl += (" The published range is itself wide because SST datasets disagree with each other (that is the paper's point), "
             "so passing means 'plausible', not 'exact'. Differences in coverage: ours is a whole-globe box mean of OISST v2 "
             "for 1982-2022, theirs is 60 deg S to 60 deg N for 1982-2024.")
    return {
        "id": "ocean-sst-warming",
        "title": "Satellite-era ocean surface warming",
        "question": "Does our sea-surface temperature trend fall in the range published for the satellite era?",
        "kind": "literature",
        "region": "Global ocean box mean (ours) vs 60 deg S to 60 deg N (published)",
        "period_ours": "1982-2022", "period_reference": "1982-2024",
        "units": "°C per decade", "decimals": 3,
        "our": {"label": "NOAA OISST v2 (via KNMI Climate Explorer), Sen slope, 95% CI persistence-adjusted",
                "value": clean(v), "ci_low": clean(lo), "ci_high": clean(hi)},
        "reference": {"label": "Menemenlis et al. 2025: four SST datasets span 0.108 to 0.184",
                      "value": clean(sum(SST_RANGE) / 2), "low": SST_RANGE[0], "high": SST_RANGE[1]},
        "rule": (f"Pass if our trend is inside {SST_RANGE[0]} to {SST_RANGE[1]} deg C/decade; "
                 f"partial if outside but same sign and within {int(TOL_SST*100)}% of the nearest edge; fail otherwise."),
        "status": status,
        "explanation": expl,
        "sources": [SRC["menemenlis"], {
            "citation": "NOAA OISST v2 (Reynolds et al. 2002, J. Climate 15, 1609-1625), box mean via KNMI Climate Explorer",
            "url": "https://climexp.knmi.nl/",
            "quote": "Field sstoi_v2, whole-globe average (missions.json, KNMI_OISSTV2_SST).",
        }],
    }


# --------------------------------------------------------------------------
# CASES 7 and 8: do independent precipitation datasets agree on trends?
#   Internal consistency, over ALL regions (no cherry-picking).
#   Per region: Sen slopes of both datasets (persistence-adjusted CIs) over
#   the common years. A region 'agrees' if the slopes have the same sign AND
#   the 95% intervals overlap.
#   Rule: pass if >= 75 % of regions agree; partial if 50 % to 75 %; fail
#   below 50 %. Median detrended year-to-year correlation is reported but
#   does not decide the status.
# --------------------------------------------------------------------------
P_PASS, P_PARTIAL = 0.75, 0.50


def gpcp_region(rid):
    r = GPCP["regions"][rid]
    # NOTE: gpcp_series.json carries the file's native "mm/day" label, but the
    # values are already annual totals in mm/yr (whole-Earth ~ 977 mm/yr =
    # 2.7 mm/day x 365). Guard against a silent unit change.
    vals = [None if v is None else float(v) for v in r["values"]]
    if rid == "whole-earth":
        mean = float(np.nanmean([v for v in vals if v is not None]))
        assert 800 < mean < 1200, f"GPCP whole-earth mean {mean} is not an annual mm total"
    return GPCP["years"], vals


def precip_consistency(case_id, title, question, a_label, b_label, a_get, b_get, y0, y1, a_src, b_src):
    rows = []
    for rid in PRESETS["T2M"]["annual"].keys():
        got_a, got_b = a_get(rid), b_get(rid)
        if got_a is None or got_b is None:
            continue
        ya, va = window(got_a[0], got_a[1], y0, y1)
        yb, vb = window(got_b[0], got_b[1], y0, y1)
        common = sorted(set(ya.astype(int)) & set(yb.astype(int)))
        if len(common) < 15:
            continue
        ma = {int(y): v for y, v in zip(ya, va)}
        mb = {int(y): v for y, v in zip(yb, vb)}
        cy = np.array(common, dtype=float)
        xa = np.array([ma[y] for y in common])
        xb = np.array([mb[y] for y in common])
        ta, tb = trend_result(cy, xa), trend_result(cy, xb)
        agree = (ta["sen_slope"] * tb["sen_slope"] > 0) and \
            (max(ta["ci_adj_low"], tb["ci_adj_low"]) <= min(ta["ci_adj_high"], tb["ci_adj_high"]))
        r = pearson_detrended(cy, xa, cy, xb)
        rows.append({
            "region": rid,
            "a_slope": clean(ta["sen_slope"] * 10), "b_slope": clean(tb["sen_slope"] * 10),
            "r": clean(r), "agree": bool(agree), "n": len(common),
        })
    n_agree = sum(1 for r in rows if r["agree"])
    frac = n_agree / len(rows)
    status = "pass" if frac >= P_PASS else ("partial" if frac >= P_PARTIAL else "fail")
    med_r = float(np.median([r["r"] for r in rows]))
    disagree = [r["region"] for r in rows if not r["agree"]]
    expl = {
        "pass": f"{a_label} and {b_label} agree on the direction and size (within uncertainty) of the precipitation trend in {n_agree} of {len(rows)} regions.",
        "partial": f"{a_label} and {b_label} agree in {n_agree} of {len(rows)} regions; the rest differ in sign or have non-overlapping uncertainty.",
        "fail": f"{a_label} and {b_label} agree in only {n_agree} of {len(rows)} regions.",
    }[status]
    expl += (f" Median detrended year-to-year correlation across regions r = {med_r:.2f}."
             + (f" Disagreeing regions: {', '.join(disagree)}." if disagree else "")
             + " Precipitation trends over 25 to 45 years carry wide intervals, so agreement is a lenient test; "
               "this check shows the datasets are consistent, not that either is exact.")
    return {
        "id": case_id,
        "title": title,
        "question": question,
        "kind": "internal",
        "region": f"All {len(rows)} regions in the app",
        "period_ours": f"{y0}-{y1}", "period_reference": f"{y0}-{y1}",
        "units": "% of regions that agree", "decimals": 0,
        "our": {"label": f"{a_label} vs {b_label}: regions with same-sign, overlapping trends",
                "value": clean(100 * frac), "ci_low": None, "ci_high": None},
        "reference": {"label": f"Pass at {int(P_PASS*100)}% or more", "value": int(P_PASS * 100), "low": int(P_PASS * 100), "high": None},
        "rule": (f"A region agrees if both datasets' Sen slopes have the same sign and their persistence-adjusted 95% intervals overlap. "
                 f"Pass if at least {int(P_PASS*100)}% of regions agree; partial if {int(P_PARTIAL*100)}% to {int(P_PASS*100)}%; fail below {int(P_PARTIAL*100)}%."),
        "status": status,
        "explanation": expl,
        "sources": [a_src, b_src],
        "details": {
            "columns": ["Region", f"{a_label} (mm/yr per decade)", f"{b_label} (mm/yr per decade)", "Detrended r", "Agree"],
            "rows": [[r["region"], r["a_slope"], r["b_slope"], r["r"], r["agree"]] for r in rows],
        },
    }


def case_precip_merra_gpcp():
    return precip_consistency(
        "precip-merra2-vs-gpcp", "Precipitation: MERRA-2 vs GPCP, 1981-2024",
        "Does the reanalysis precipitation trend agree with the gauge-satellite observational product?",
        "MERRA-2", "GPCP",
        lambda rid: (PRESETS["PRECTOTCORR"]["annual"][rid]["years"], PRESETS["PRECTOTCORR"]["annual"][rid]["values"]),
        lambda rid: gpcp_region(rid) if rid in GPCP["regions"] else None,
        1981, 2024, SRC["merra2"], SRC["gpcp"])


def case_precip_imerg_gpcp():
    return precip_consistency(
        "precip-imerg-vs-gpcp", "Precipitation: IMERG vs GPCP, 1998-2024",
        "Do two satellite precipitation products agree on the trend over the IMERG era?",
        "IMERG", "GPCP",
        lambda rid: (MISSIONS["IMERG_PRECIP"]["annual"][rid]["years"], MISSIONS["IMERG_PRECIP"]["annual"][rid]["values"])
        if rid in MISSIONS["IMERG_PRECIP"]["annual"] else None,
        lambda rid: gpcp_region(rid) if rid in GPCP["regions"] else None,
        1998, 2024, SRC["imerg"], SRC["gpcp"])


# --------------------------------------------------------------------------
# CASE 9: the challenge's own paper -- explained mismatch, not scored
# --------------------------------------------------------------------------

def case_acker():
    return {
        "id": "seawifs-river-chlorophyll",
        "title": "SeaWiFS chlorophyll near river mouths (challenge paper)",
        "question": "Can we reproduce the coastal chlorophyll trends in the paper the challenge lists?",
        "kind": "not-comparable",
        "region": "Nine river-influenced coastal regions (paper) vs global ocean boxes (ours)",
        "period_ours": "-", "period_reference": "SeaWiFS era (study period not stated on the NTRS page)",
        "units": "-", "decimals": 0,
        "our": {"label": "Not computed", "value": None, "ci_low": None, "ci_high": None},
        "reference": {"label": "Acker et al. 2009: low-impact rivers show no significant trend; most human-impacted rivers show significant decreases (Pearl River increases)",
                      "value": None, "low": None, "high": None},
        "rule": "Not scored. A check needs the same quantity in the same place: the paper's nine river-mouth boxes are not published as files, "
                "and our ocean chlorophyll series is the NOBM model, not SeaWiFS.",
        "status": "not-comparable",
        "explanation": "We deliberately do not score this one. The paper analyses SeaWiFS satellite chlorophyll in nine small coastal boxes, where "
                       "dissolved organic matter and sediment disturb the signal; our NOBM chlorophyll is a model product on coarse regional boxes that "
                       "contain no river-mouth cells. Comparing them would produce a number with no meaning. What carries over is the lesson: "
                       "coastal chlorophyll trends can reflect floods and water colour, not just phytoplankton, so we flag such series with cautions.",
        "sources": [SRC["acker"]],
    }


def main():
    cases = [
        case_global_temp(), case_arctic(), case_debilt_knmi(), case_station_vs_reanalysis(),
        case_india_no2(), case_sst(), case_precip_merra_gpcp(), case_precip_imerg_gpcp(), case_acker(),
    ]
    scored = [c for c in cases if c["status"] in ("pass", "partial", "fail")]
    summary = {
        "scored": len(scored),
        "pass": sum(1 for c in scored if c["status"] == "pass"),
        "partial": sum(1 for c in scored if c["status"] == "partial"),
        "fail": sum(1 for c in scored if c["status"] == "fail"),
        "not_comparable": sum(1 for c in cases if c["status"] == "not-comparable"),
    }
    out = {
        "generated_by": "pipeline/build_validation.py",
        "references_verified_on": VERIFIED_ON,
        "method": "Our values use pipeline/stats.py (Sen slope, persistence-adjusted Mann-Kendall interval) on the shipped data assets.",
        "summary": summary,
        "cases": cases,
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")
    for c in cases:
        o, r = c["our"]["value"], c["reference"]
        print(f"[{c['status']:>14}] {c['id']:<28} ours={o}  ref={r.get('low')}..{r.get('high')}  ({c['units']})")
    print(summary)


if __name__ == "__main__":
    main()
