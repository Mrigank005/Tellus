# Tellus

### What is Earth telling us?

> **Why “Tellus”?** *Tellus* is Latin for “Earth”. The Romans had a goddess of the same name, and she was apparently a great listener. Our planet has been talking for 4.5 billion years, mostly in noisy data, and nobody was taking notes. So we built an app that does, then asks the data to prove it wasn't just having a bad year.

**Become an Earth data detective.** Find what is changing, where, how fast — and whether the change is *statistically significant* — using NASA Earth science data.

Built for the NASA Space Apps Challenge: *“A tool that selects Earth-science variables, visualizes how they change over time, and determines what is changing, where, how much, and if the changes are significant.”*

---

## The one-minute version

Earth's connected system is always moving — and a measured variable can rise in one region while falling in another, even when one process drives both. Tellus covers the **whole Earth** (207,936 MERRA-2 grid cells, 1981–2025) and walks a student or citizen scientist through the full detective workflow:

1. **Pick a place or a variable** (or ask **Laya**, our transparent rules-based guide)
2. **See the evidence**: a worldwide per-pixel trend map, the area-weighted time series, and a confidence band
3. **Read the verdict**: *statistically detected increase / decrease / no detected trend / insufficient data* — with the trend per decade, its 95% confidence interval, and the p-value
4. **Draw your own region anywhere on Earth** — Tellus fetches that area's monthly NASA data *live in your browser* and analyses it on the spot
5. **Stress-test the story**: does it survive a different time window or season? Do the model and the *observed* satellite record agree?
6. **Download the evidence package**: CSV of the series, provenance JSON, printable report

Regional statistics run **live in your browser**, in a TypeScript engine that is **parity-tested against the validated Python reference implementation** (300-series statistics parity + aggregation parity fixtures). Global maps are precomputed with the same engine and lazy-loaded per view.

## What makes it honest science, not just charts

| Principle            | How Tellus implements it                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiplicity is real | Per-pixel Mann-Kendall p-values get **Benjamini–Hochberg FDR correction** across the whole map (one variable × one map × one window × one season) |
| Robust magnitudes    | **Sen's slope** (median of pairwise slopes) with Gilbert's 95% CI — robust to outliers                                                               |
| Second opinion       | OLS slope + t-test run alongside; disagreement triggers a visible *interpretation caution*                                                                |
| Missing ≠ zero      | Years with too few months are invalidated, never filled; totals require complete months                                                                     |
| Area, not pixels     | Regional means and area fractions weighted by cos(latitude) — true Earth-area weighting                                                                    |
| Colour ≠ judgement  | Map colour encodes direction and size of change, never “good” or “bad”                                                                                  |
| Models can be wrong  | Precipitation is cross-checked against the **observed GPCP V2.3** record; divergences are surfaced loudly, not hidden                                 |
| Short series mislead | Sensitivity panel shows every window × season combination; a trend that only exists in one window is shown as exactly that                                 |

**A real finding from this app:** over the Western Ghats, the MERRA-2 model shows monsoon rainfall increasing (+136 mm/decade) while the observed GPCP record shows essentially no trend (−5 mm/decade). Tellus flags this disagreement automatically — reanalysis precipitation over South Asia is a known model artifact, and our tool teaches users to catch exactly this kind of thing.

## Data

All data is open and comes from the NASA Space Apps 2026 resource list or NASA's own services. Every download is logged with its request URL and UTC time (`data/raw/missions/fetch_log*.jsonl`).

| Dataset                                                                                    | Role                                                        | Coverage                                | Access                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| **NASA POWER monthly regional API** (MERRA-2, source-native 0.5°×0.625° grid)     | Primary analysis data: 8 variables, global per-pixel maps   | 1981–2025, whole planet, 207,936 cells | POWER API, no login                                   |
| **GPM IMERG Final monthly V07**                                                      | Observed satellite precipitation                            | 1998–2024                              | Giovanni area-averaged series                         |
| **GLDAS Noah v2.1** (surface runoff, evapotranspiration, soil moisture)              | Second NASA land model                                      | 2000–2025                              | Giovanni                                              |
| **AIRS / Aqua surface air temperature v7**                                           | Satellite temperature                                       | 2003–2025                              | Giovanni                                              |
| **OMI / Aura** tropospheric nitrogen dioxide and aerosol optical depth               | Air-quality satellite series                                | 2005–2025                              | Giovanni (daily, averaged to months)                  |
| **NASA NOBM ocean biogeochemical model** chlorophyll                                 | Ocean productivity (18-year record, flagged)                | 1998–2015                              | Giovanni                                              |
| **NOAA OISST v2**, **NOAA CDR NDVI**, **CMORPH** satellite precipitation | Sea-surface temperature, vegetation, second rainfall record | 1981–2025 (varies)                     | KNMI Climate Explorer (Space Agency Partner resource) |
| **NOAA NCEI Global Summary of the Month**                                            | Weather-station ground truth (De Bilt)                      | 1901–2025                              | NCEI Access Data Service                              |
| **GPCP V2.3** (NOAA PSL)                                                             | Observed cross-check for model precipitation                | 1979–2025, 2.5°                       | NOAA PSL                                              |

22 preset regions span every continent and ocean. Any user-drawn region is fetched live from NASA POWER in the browser. Mission and model variables are shown as regional series and region-verdict maps; only the MERRA-2 variables have per-pixel global maps.

Variables from MERRA-2: Temperature (T2M), Daytime max, Nighttime min, Precipitation, Relative humidity, Wind speed at 10 m, Surface soil wetness, Evaporation. Each has a plain-language definition in the in-app **Variable Library**.

> Data citation: NASA Langley Research Center POWER Project (MERRA-2-based meteorology); GES DISC Giovanni (GPM IMERG, GLDAS, AIRS, OMI, NOBM); KNMI Climate Explorer; NOAA NCEI; GPCP Version 2.3, NOAA PSL / NASA GES DISC.

### Record length rule

A trend needs at least **20 valid years**. The one exception is ocean chlorophyll (NASA's NOBM, 1998–2015), which has 18 years; it is accepted for that variable only and is always labelled a short series.

### Future scope

- **MODIS vegetation and aerosol.** Giovanni offers no MODIS products, so MODIS NDVI and aerosol optical depth would come from AppEEARS. They are not used here; NOAA's NDVI (KNMI) and OMI aerosol cover the same questions.
- Per-pixel maps for the satellite variables.
- NISAR radar and SWOT surface water from the Space Agency Partner resources.

## The student experience (2026-11-13 build)

- **Three-question wizard** — where, what kind of place, what worries you — returns a ranked variable shortlist with student-readable reasons (the brief's Approach paragraph, built literally)
- **Plain-language verdicts first** — "this region is trending toward warmer by about 0.46 °C per decade — extremely unlikely to chance"; every statistic sits behind *Show the statistics*
- **"Not significant — yet?"** — for undetected trends, an estimate of how many more years of data would settle it (Weatherhead-style solve)
- **Seasonal-cycle reveal** — raw monthly values, the average yearly cycle drawn on top, then the same months with the cycle removed
- **Opposite-trends finder** — one click to the strongest preset-region pair moving in opposite directions (e.g. Amazonia −35 vs Himalaya +46 mm/decade in monsoon rainfall)
- **Watchable guided tours** — two narrated case files that drive the app themselves
- **Exploratory event diagnostics** — precomputed static anomalies/change-points, clearly quarantined from the verdicts
- **Optional AI copilot** — server-side, grounded, falls back to Laya (rules engine) when offline; the app never depends on it
- **Mission-variable plumbing** — drop NASA Giovanni CSVs into `data/raw/missions/` and run `pipeline/build_missions.py`; satellite variables appear with region-verdict maps and instrument citations

## Run it

```bash
# full pipeline (data already committed as static assets — optional)
pip install -r requirements.txt
python pipeline/fetch_power.py      # 5,184 tiles (648 per variable), ~1.5 h, no auth
python pipeline/fetch_gpcp.py
python pipeline/build_assets.py     # rebuilds frontend/public/data/*
python -m pytest tests              # validation + AI contract tests

# frontend
cd frontend && npm install && npm run dev
```

### Optional AI copilot

The AI copilot runs through a separate backend so the provider API key never
reaches the browser. Install the Python requirements, copy
`backend/.env.example` to a private environment file, set `LLM_API_KEY`, and
start the service:

```bash
uvicorn backend.app.main:app --reload --port 8000
```

The default provider configuration targets OpenRouter with
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`. This model is used in
server-side JSON-prompt mode and responses are validated against the
Tellus schema. Set `LLM_STRUCTURED_OUTPUTS=true` only when using a model
that explicitly supports the requested JSON Schema response format.

The backend exposes bounded, read-only tools for preset analysis, region
comparison, and GPCP precipitation cross-checks. It also provides
`/api/catalog/options` and `/api/sources/search`; these tools reuse the
validated Tellus engine rather than asking the model to calculate
statistics. The copilot endpoint is rate-limited and rejects unverified
numeric claims.

Run the backend golden evaluation without provider calls by temporarily
starting it with an empty `LLM_API_KEY`; the evaluation cases live in
`evaluation/golden_questions.json`. Exploratory anomaly diagnostics are
available in `pipeline/anomaly.py` and are intentionally separate from the
statistical verdict.

The frontend remains fully usable without the backend; Laya is the offline
rules-based fallback. The AI answers only from validated evidence
and abstains on causes and forecasts.

The production build (`npm run build`) is a **fully static site** — deployable on any static host, works offline after first load, no API keys, no cold starts.

## Validation

- **47+ Python tests**: known-slope recovery, false-positive calibration (2000 sims ≈ α), AR(1) autocorrelation behaviour, outlier robustness, unit-conversion and area-weighting hand checks, determinism, and exact-equality tests of the vectorized global engine against the per-series reference
- **Python ↔ TypeScript parity**: 300 synthetic series + FDR + special functions match (tolerances down to 1e-9), plus a Python-generated aggregation fixture the TS port must reproduce exactly
- **Real-data cross-checks**: aggregation verified against POWER's own annual values (±0.03 °C); regional results reproduce published-order warming rates; GPCP cross-check matches independent analysis

## Architecture

```
pipeline/   Python: fetch → aggregate (annual/JJAS/DJF) → statistics → static assets
frontend/   React + TypeScript: MapLibre map, ECharts, in-browser stats engine
data flow   All analysis runs client-side from committed static assets (~68 MB of packs, lazy-loaded)
```

Statistical methods: Gilbert (1987); Helsel & Hirsch (2002); Benjamini–Hochberg (1995).

## Use of AI / Super Intelligence (SI) disclosure

- **Laya**, the in-app assistant, is a **transparent rules engine** — no LLM calls, no black boxes. It routes natural-language questions to supported variables and *abstains* on causality, forecasting, and unsupported topics, explaining why.
- AI coding assistants were used during development to accelerate implementation; all statistical logic was designed, tested, and validated as described above, and every claim the app makes comes from the validated engine, not from generated text.

## Limitations (stated in-app too)

- Custom drawn regions are limited to roughly 30°×30° (live NASA fetch politeness) and require internet; preset regions work offline
- Linear trend analysis only; seasonal cycle handled via seasonal windows, not removed statistically
- Reanalysis 2-metre temperature over the Indo-Gangetic Plain diverges from surface-station records (documented in the Variable Library)
- BH-FDR's independence assumption is not strictly satisfied by spatially correlated pixels (BY variant available in config)
- Short windows + strict map-wide correction can honestly yield zero detected cells (e.g. 20-winter maps) — the tool says so instead of faking significance
- Results describe the analysed record — **not forecasts**
