import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import {
  loadCatalog, loadGrid, loadPresets, loadGpcp, loadTrendPack,
  loadMissions, loadMissionVariables, getSeriesEntry,
  type Catalog, type GpcpData, type Grid, type MissionVariable, type Missions,
  type Presets, type TrendPack, type VariableMeta,
} from '../engine/loader'
import { computeRegionVerdicts, type RegionVerdict } from '../engine/missions'
import MonthlyChart from './MonthlyChart'
import { loadMonthlyPresets, type MonthlyPresets } from '../engine/loader'
import { regionAnalysis, areaSummary, type AnalysisConfig, type RegionAnalysis } from '../engine/analysis'
import { detectionHorizon, residualSd } from '../engine/detect'
import { plainVerdict, plainHorizon } from '../engine/explain'
import { findOppositeTrends, type ContrastPair } from '../engine/contrast'
import type { Summarized as SummT } from '../engine/stats'
import type { Summarized } from '../engine/stats'
import { LABELS, pettitt, slopeDifference, timeOfEmergence } from '../engine/stats'
import {
  changePointExplain, changePointLabel, changePointVisible, differenceDetail,
  differenceHeadline, emergenceSentence, relationText,
} from '../engine/narrative'
import { regionRelation } from '../engine/regionOverlap'
import { fetchLiveMonthly, liveSeason, type BBox } from '../engine/powerLive'
import { regionSeries } from '../engine/geography'
import MapCanvas, { legendGradient, slopeVmax } from './MapCanvas'
import TrendChart from './TrendChart'
import SensitivityPanel from './SensitivityPanel'
import ExportPanel from './ExportPanel'
import GpcpPanel from './GpcpPanel'
import CrossCheckPanel from './CrossCheckPanel'
import AnomalyPanel from './AnomalyPanel'

const LABEL_TEXT: Record<string, { text: string; cls: string }> = {
  'detected-increase': { text: 'Statistically detected increase', cls: 'pill-increase' },
  'detected-decrease': { text: 'Statistically detected decrease', cls: 'pill-decrease' },
  'no-detected-trend': { text: 'No statistically detected trend', cls: 'pill-none' },
  'insufficient-data': { text: 'Insufficient data', cls: 'pill-insufficient' },
}

function bboxOf(polygon: number[][]): BBox {
  let lonMin = 180, lonMax = -180, latMin = 90, latMax = -90
  for (const [lo, la] of polygon) {
    lonMin = Math.min(lonMin, lo); lonMax = Math.max(lonMax, lo)
    latMin = Math.min(latMin, la); latMax = Math.max(latMax, la)
  }
  return { lonMin, lonMax, latMin, latMax }
}

export default function WorkspaceScreen() {
  const store = useStore()
  const [cat, setCat] = useState<Catalog | null>(null)
  const [grid, setGrid] = useState<Grid | null>(null)
  const [pack, setPack] = useState<TrendPack | null>(null)
  const [analysis, setAnalysis] = useState<RegionAnalysis | null>(null)
  const [compareAnalysis, setCompareAnalysis] = useState<RegionAnalysis | null>(null)
  const [gpcp, setGpcp] = useState<GpcpData | null>(null)
  const [presets, setPresets] = useState<Presets | null>(null)
  const [missions, setMissions] = useState<Missions | null>(null)
  const [missionVars, setMissionVars] = useState<MissionVariable[]>([])
  const [busy, setBusy] = useState(true)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [hover, setHover] = useState<{ lon: number; lat: number; pixelIdx: number } | null>(null)
  const [showSignificance, setShowSignificance] = useState(true)
  const [tab, setTab] = useState<'series' | 'sensitivity' | 'exploratory' | 'methods' | 'export'>('series')
  const [contrasts, setContrasts] = useState<ContrastPair[] | null>(null)
  const [monthlyMode, setMonthlyMode] = useState<'annual' | 'monthly' | 'deseasonalised'>('annual')
  const [monthlyPresets, setMonthlyPresets] = useState<MonthlyPresets | null>(null)

  const allVars: VariableMeta[] = [...(cat?.variables ?? []), ...missionVars]
  const variable = allVars.find((v) => v.id === store.variableId)
  const windowMeta = cat?.windows.find((w) => w.id === store.windowId)
  const region = cat?.regions.find((r) => r.id === store.regionId)

  // a variable may declare a shorter record threshold (e.g. ocean chlorophyll,
  // 18 years); it is labelled in the UI wherever it applies
  const varMinYears = (variable as VariableMeta & { min_years?: number } | undefined)?.min_years
  const cfg: AnalysisConfig | null = useMemo(() => {
    if (!cat?.methods) return null
    const m = cat.methods
    const minYears = varMinYears ?? m.min_years
    return {
      alpha: m.alpha, minYears,
      cautionYears: Math.max(minYears, m.caution_years),
      conf: m.confidence_level, fdrMethod: 'bh',
    }
  }, [cat, varMinYears])

  // catalog / grid / presets / gpcp once
  useEffect(() => {
    Promise.all([loadCatalog(), loadGrid(), loadPresets(), loadGpcp(),
                 loadMissions(), loadMissionVariables(), loadMonthlyPresets()])
      .then(([c, g, p, gp, m, mv, mp]) => {
        setCat(c); setGrid(g); setPresets(p); setGpcp(gp)
        setMissions(m); setMissionVars(mv); setMonthlyPresets(mp)
      })
      .catch((e) => console.error(e))
  }, [])

  // map pack on variable/season/window change
  useEffect(() => {
    if (!cat) return
    if (missionVars.some((v) => v.id === store.variableId)) {
      setPack(null)
      setBusy(false)
      return
    }
    let cancelled = false
    setBusy(true)
    loadTrendPack(store.variableId, store.season, store.windowId, cat.n_cells)
      .then((p) => { if (!cancelled) setPack(p) })
      .catch((e) => { console.error(e); if (!cancelled) setPack(null) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [cat, store.variableId, store.season, store.windowId])

  // regional analyses
  useEffect(() => {
    if (!cat || !cfg || !variable || !windowMeta || !presets) return
    let cancelled = false
    const win = { start: windowMeta.start, end: windowMeta.end }
    const run = async () => {
      // Region A
      if (store.regionId === 'custom' && store.customPolygon) {
        setLiveStatus('Fetching live NASA data…')
        try {
          const bbox = bboxOf(store.customPolygon)
          const live = await fetchLiveMonthly(
            variable.power_parameter, bbox,
            (d, t) => setLiveStatus(`Fetching live NASA data… ${d}/${t} tiles`),
          )
          if (cancelled) return
          const season = liveSeason(live, store.season, variable.aggregation, cat.seasons)
          const nYears = season.years.length
          const sub = new Float32Array(season.values.length)
          for (let i = 0; i < season.values.length; i++) sub[i] = season.values[i]
          const rs = regionSeries(sub, Float64Array.from(live.lons),
            Float64Array.from(live.lats), nYears, store.customPolygon as number[][])
          const sel: (number | null)[] = Array.from(rs.values).map((v) =>
            Number.isFinite(v) ? v : null)
          const a = regionAnalysis(season.years, sel, rs.nCells, win, cfg)
          if (!cancelled) setAnalysis({ ...a, coverage: Math.min(...rs.nValid) / Math.max(1, rs.nCells) })
        } catch (e) {
          console.error(e)
          if (!cancelled) setLiveStatus(`Live fetch failed: ${(e as Error).message}`)
        } finally {
          if (!cancelled) setLiveStatus(null)
        }
      } else if (store.regionId !== 'custom') {
        const mKey = (variable as VariableMeta & { has_global_map?: boolean }).has_global_map === false
          ? variable.id : variable.power_parameter
        const entry = await getSeriesEntry(mKey, store.season, store.regionId, presets, missions)
        if (entry) {
          setAnalysis(regionAnalysis(entry.years, entry.values, entry.n_cells, win, cfg))
        }
      }
      // Region B (presets only)
      if (store.compareRegionId && store.compareRegionId !== 'custom') {
        const mKey = (variable as VariableMeta & { has_global_map?: boolean }).has_global_map === false
          ? variable.id : variable.power_parameter
        const entry = await getSeriesEntry(mKey, store.season, store.compareRegionId, presets, missions)
        if (entry) {
          setCompareAnalysis(regionAnalysis(entry.years, entry.values, entry.n_cells, win, cfg))
        }
      } else {
        setCompareAnalysis(null)
      }
    }
    run()
    return () => { cancelled = true }
  }, [cat, cfg, variable, windowMeta, presets, store.regionId,
      store.customPolygon, store.compareRegionId, store.season])

  const fractions = useMemo(
    () => (pack && grid ? areaSummary(pack.label, grid) : null),
    [pack, grid],
  )

  // diagnostics on the displayed series: time of emergence, change point
  const diag = useMemo(() => {
    if (!analysis || !cfg) return null
    const yrs = analysis.years
    const vals = Array.from(analysis.series.values)
    const em = timeOfEmergence(yrs, vals, cfg.minYears, cfg.alpha, cfg.cautionYears)
    const pt = pettitt(yrs, vals)
    const units = variable?.units ?? ''
    const emSentence = emergenceSentence(em, cfg.minYears, yrs[0])
    const emergenceMarker = em.status === 'emerged' && em.emergenceYear !== null
      ? { year: em.emergenceYear, label: `clear from ${em.emergenceYear}`, tooltip: emSentence }
      : null
    const cpVisible = changePointVisible(pt)
    const changeMarker = cpVisible
      ? {
        x: (pt.yearBefore! + pt.year!) / 2,
        label: `shift ~${pt.year}?`,
        tooltip: `${changePointLabel(pt)}<br/>${changePointExplain(pt, units)}`,
      }
      : null
    return { em, pt, emSentence, emergenceMarker, changeMarker, cpVisible }
  }, [analysis, cfg, variable])

  // two-region difference of trends (shared years only, persistence-adjusted)
  const diffTest = useMemo(() => {
    if (!analysis || !compareAnalysis || !cfg) return null
    return slopeDifference(
      analysis.years, Array.from(analysis.series.values),
      compareAnalysis.years, Array.from(compareAnalysis.series.values),
      cfg.minYears, cfg.alpha, cfg.conf,
    )
  }, [analysis, compareAnalysis, cfg])

  function runContrastFinder() {
    if (!presets || !variable || !windowMeta) return
    setContrasts(findOppositeTrends(
      presets, variable.power_parameter, store.season,
      windowMeta.start, windowMeta.end,
      cfg?.alpha ?? 0.05, cfg?.minYears ?? 20, cfg?.cautionYears ?? 25,
    ))
  }

  if (!cat || !variable || !windowMeta || !cfg || !grid) {
    return <div className="loading"><div className="spinner" /> Loading data…</div>
  }

  const summary = analysis?.summary as (Summarized | { n: number; label: string }) | undefined
  const cmpSummary = compareAnalysis?.summary
  const horizon = (() => {
    if (!analysis) return null
    const t = summary as SummT | undefined
    if (!t || t.label !== 'no-detected-trend' || !('senSlope' in t) || !('lag1R' in t)) return null
    const sd = residualSd(Array.from(analysis.series.values).filter(Number.isFinite))
    return detectionHorizon(t.n, t.senSlope, sd, t.lag1R)
  })()
  const polygon = store.customPolygon ?? region?.polygon ?? null
  const cmpRegionMeta = store.compareRegionId && store.compareRegionId !== 'custom'
    ? cat.regions.find((r) => r.id === store.compareRegionId) : null

  const isMissionVar = (variable as VariableMeta & { has_global_map?: boolean })?.has_global_map === false
  const seriesKey = isMissionVar ? variable.id : (variable as VariableMeta).power_parameter
  const regionVerdicts = (() => {
    if (!isMissionVar || !cat || !cfg || !missions) return null
    const byRegion: Record<string, { years: number[]; values: (number | null)[] } | undefined> = {}
    for (const r of cat.regions) {
      const e = missions[variable.id]?.[store.season]?.[r.id]
      if (e) byRegion[r.id] = e
    }
    return computeRegionVerdicts(cat.regions, byRegion,
      { start: windowMeta!.start, end: windowMeta!.end }, cfg)
  })()

  const slopeDec = summary && 'senSlope' in summary ? summary.senSlope * 10 : NaN
  const ciLowDec = summary && 'ciAdjLow' in summary ? summary.ciAdjLow * 10 : NaN
  const ciHighDec = summary && 'ciAdjHigh' in summary ? summary.ciAdjHigh * 10 : NaN
  const naiveDiffers = summary && 'mkP' in summary && 'mkPAdj' in summary
    && summary.mkP < 0.05 && summary.mkPAdj >= 0.05

  let vmaxPerDecade = 0
  if (pack) vmaxPerDecade = slopeVmax(pack.slope) * 10

  return (
    <>
      {/* control strip */}
      <div className="row" style={{ padding: '12px 18px 0', gap: 8 }}>
        <div className="seg">
          {allVars.map((v) => (
            <button key={v.id} className={v.id === store.variableId ? 'on' : ''}
              onClick={() => store.setVariable(v.id)} title={v.long_name}>
              {v.short_name}{(v as VariableMeta & { source_type?: string }).source_type === 'mission' ? ' ⚛' : ''}
            </button>
          ))}
        </div>
        <div className="seg">
          {Object.entries(cat.seasons).map(([id, s]) => (
            <button key={id} className={id === store.season ? 'on' : ''}
              onClick={() => store.setSeason(id)}>{s.label.split(' (')[0]}</button>
          ))}
        </div>
        <div className="seg">
          {cat.windows.map((w) => (
            <button key={w.id} className={w.id === store.windowId ? 'on' : ''}
              onClick={() => store.setWindow(w.id)}>
              {w.id === 'full' ? 'Full record' : w.id === 'w30' ? '30 yr' : '20 yr'}
            </button>
          ))}
        </div>
        <div className="seg">
          <select
            value={store.regionId}
            onChange={(e) => store.setRegion(e.target.value)}
            style={{ background: 'var(--panel-2)', color: 'var(--text)', border: 'none', padding: '8px 10px', fontSize: 13.5, borderRadius: 8 }}
          >
            {store.regionId === 'custom' && <option value="custom">Custom region</option>}
            {cat.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="seg">
          <select
            value={store.compareRegionId ?? ''}
            onChange={(e) => store.setCompare(e.target.value || null)}
            style={{ background: 'var(--panel-2)', color: 'var(--text)', border: 'none', padding: '8px 10px', fontSize: 13.5, borderRadius: 8 }}
          >
            <option value="">Compare with…</option>
            {cat.regions.filter((r) => r.id !== store.regionId).map((r) => (
              <option key={r.id} value={r.id}>vs {r.name}</option>
            ))}
          </select>
        </div>
        <div className="seg">
          <button className={showSignificance ? 'on' : ''} onClick={() => setShowSignificance((v) => !v)}>
            {showSignificance ? 'Significance shading: on' : 'Significance shading: off'}
          </button>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <button className={`ghost ${store.drawing ? 'on' : ''}`} onClick={() => store.setDrawing(!store.drawing)}>
          {store.drawing ? 'Click two opposite corners on the map…' : '✏ Draw custom region'}
        </button>
      </div>

      <div className="workspace">
        {/* ---------------- map ---------------- */}
        <div className="mapwrap">
          {busy && (
            <div className="loading" style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(7,11,20,0.55)' }}>
              <div className="spinner" /> Loading trend map…
            </div>
          )}
          {liveStatus && (
            <div className="loading" style={{ position: 'absolute', inset: 0, zIndex: 41, background: 'rgba(7,11,20,0.65)' }}>
              <div className="spinner" /> {liveStatus}
            </div>
          )}
          <MapCanvas
            grid={grid ?? { lats: new Float64Array(0), lons: new Float64Array(0) }}
            domain={cat.domain}
            trends={pack}
            showSignificance={showSignificance}
            regionA={polygon}
            regionB={cmpRegionMeta?.polygon ?? null}
            drawing={store.drawing}
            onDrawn={(poly) => { store.setRegion('custom', poly); store.setDrawing(false) }}
            onHover={setHover}
            trendUnits={variable.trend_units}
            regionVerdicts={regionVerdicts}
          />
          {isMissionVar ? (
            <div className="maplegend">
              <b>{variable.trend_units}</b>
              <div className="lrow"><span className="sw" style={{ background: '#e1694b' }} /> detected increase</div>
              <div className="lrow"><span className="sw" style={{ background: '#4f7fd8' }} /> detected decrease</div>
              <div className="lrow"><span className="sw" style={{ background: '#3a465e' }} /> no detected trend</div>
              <div className="lrow muted" style={{ marginTop: 6 }}>Regional results — no per-pixel map for
                this variable. Regions with too little data are drawn nearly black.</div>
            </div>
          ) : (
            legendGradient(vmaxPerDecade || 1, variable.trend_units)
          )}
          <HoverTooltip hover={hover} trends={pack} />
        </div>

        {/* ---------------- side panel ---------------- */}
        <div className="sidepanel">
          <div className="verdict">
            <div className="vl">Verdict · {store.regionId === 'custom' ? 'Custom region (live NASA fetch)' : region?.name}</div>
            {summary ? (
              <>
                <div className="headline">
                  {LABEL_TEXT[summary.label]?.text ?? summary.label}
                </div>
                {analysis && 'senSlope' in summary && (
                  <p className="small" style={{ margin: '2px 0 0', color: 'var(--text)' }}>
                    {plainVerdict(summary as SummT, variable.trend_units, variable.higher_means, analysis.years)}
                  </p>
                )}
                {diag && diag.em.status !== 'insufficient-data' && summary.label !== LABELS.insufficientData && (
                  <p className="small" style={{ margin: '6px 0 0', color: 'var(--text)' }}>
                    {diag.emSentence}
                  </p>
                )}
                {horizon && (
                  <div className="cautionbox" style={{ marginTop: 10 }}>
                    <b>Not significant — yet?</b> {plainHorizon(horizon.moreYears, horizon.cappedAt)}
                  </div>
                )}
                {summary.label !== LABELS.insufficientData && 'senSlope' in summary && (
                  <div className="num">
                    {slopeDec >= 0 ? '+' : ''}{slopeDec.toFixed(2)} {variable.trend_units}
                    <span className="muted"> (95% CI {ciLowDec >= 0 ? '+' : ''}{ciLowDec.toFixed(2)} to{' '}
                      {ciHighDec >= 0 ? '+' : ''}{ciHighDec.toFixed(2)})</span>
                  </div>
                )}
                {naiveDiffers && (
                  <div className="cautionbox" style={{ marginTop: 8 }}>
                    <b>Naive test would have called this significant.</b> Adjusting for
                    year-to-year persistence (lag-1 r ≈ {'lag1R' in (summary as object) ? ((summary as any).lag1R).toFixed(2) : '—'},
                    effective n ≈ {'nEff' in (summary as object) ? Math.round((summary as any).nEff) : '—'}) moves the
                    p-value from {(summary as any).mkP.toPrecision(2)} to {(summary as any).mkPAdj.toPrecision(2)}.
                  </div>
                )}
                {summary.label !== LABELS.insufficientData && 'caution' in summary && summary.caution && (
                  <div className="cautionbox" style={{ marginTop: 10 }}>
                    <b>Interpretation caution.</b> {summary.cautionReasons.join('; ')}.
                  </div>
                )}
                <details style={{ marginTop: 8 }}>
                  <summary className="muted small" style={{ cursor: 'pointer' }}>Show the statistics</summary>
                  <div style={{ marginTop: 6 }}>
                  <div className="statrow"><span className="k">Mann-Kendall p (adjusted)</span>
                    <span className="v">{'mkPAdj' in summary ? (summary as any).mkPAdj.toPrecision(3) : '—'}</span></div>
                  <div className="statrow"><span className="k">Mann-Kendall p (naive)</span>
                    <span className="v">{'mkP' in summary ? summary.mkP.toPrecision(3) : '—'}</span></div>
                  <div className="statrow"><span className="k">Year-to-year persistence r</span>
                    <span className="v">{'lag1R' in (summary as object) ? (summary as any).lag1R.toFixed(2) : '—'}</span></div>
                  <div className="statrow"><span className="k">OLS slope (cross-check)</span>
                    <span className="v">{'olsSlope' in summary ? ((summary.olsSlope * 10) >= 0 ? '+' : '') + (summary.olsSlope * 10).toFixed(3) + ' /dec' : '—'}</span></div>
                  <div className="statrow"><span className="k">Valid years · cells</span>
                    <span className="v">{summary.n} · {analysis?.series.nCells}</span></div>
                  <div className="statrow"><span className="k">Data coverage</span>
                    <span className="v">{(analysis ? analysis.coverage * 100 : NaN).toFixed(0)}%</span></div>
                  {store.regionId === 'custom' && (
                    <div className="statrow"><span className="k">Data source</span>
                      <span className="v">live NASA POWER fetch</span></div>
                  )}
                  </div>
                </details>
              </>
            ) : <div className="muted">Computing…</div>}
          </div>

          {cmpSummary && compareAnalysis && (() => {
            const nameA = store.regionId === 'custom' ? 'Custom region' : region?.name ?? 'A'
            const nameB = cmpRegionMeta?.name ?? 'B'
            const rel = polygon && cmpRegionMeta
              ? regionRelation(polygon, cmpRegionMeta.polygon) : 'separate'
            const overlapping = rel !== 'separate'
            const unitsShort = variable.trend_units.replace(' per decade', '')
            return (
              <div className="card">
                <h3>A ↔ B comparison</h3>
                <RegionStat name={nameA} summary={summary} variable={variable} color="#4f9cf9" />
                <RegionStat name={nameB} summary={cmpSummary} variable={variable} color="#ffb547" />
                {diffTest && (
                  <div style={{ marginTop: 10 }}>
                    <div className="headline" style={{ fontSize: 15 }}>
                      {differenceHeadline(diffTest, overlapping)}
                    </div>
                    {overlapping && diffTest.label !== 'insufficient-data' && (
                      <div className="cautionbox" style={{ marginTop: 8 }}>
                        <b>These regions overlap, so the test is approximate.</b>{' '}
                        {relationText(rel, nameA, nameB)}: the two series share the same
                        grid cells, so they are not independent samples. Treat the result
                        as a rough guide, not a clean verdict.
                      </div>
                    )}
                    <p className="small" style={{ margin: '8px 0 0', color: 'var(--text)' }}>
                      {differenceDetail(diffTest, unitsShort)}
                    </p>
                    {diffTest.label !== 'insufficient-data' && (
                      <details style={{ marginTop: 6 }}>
                        <summary className="muted small" style={{ cursor: 'pointer' }}>Show the statistics</summary>
                        <div style={{ marginTop: 6 }}>
                          <div className="statrow"><span className="k">Slope A · B (per decade)</span>
                            <span className="v">{(diffTest.slopeA! * 10).toFixed(3)} · {(diffTest.slopeB! * 10).toFixed(3)}</span></div>
                          <div className="statrow"><span className="k">Adjusted SE A · B (per decade)</span>
                            <span className="v">{(diffTest.seA! * 10).toFixed(3)} · {(diffTest.seB! * 10).toFixed(3)}</span></div>
                          <div className="statrow"><span className="k">z = (b<sub>A</sub> − b<sub>B</sub>) / √(se<sub>A</sub>² + se<sub>B</sub>²)</span>
                            <span className="v">{diffTest.z!.toFixed(2)}</span></div>
                          <div className="statrow"><span className="k">Welch df · two-sided p</span>
                            <span className="v">{diffTest.df!.toFixed(1)} · {diffTest.p!.toPrecision(3)}</span></div>
                          <div className="statrow"><span className="k">Persistence r (A · B)</span>
                            <span className="v">{diffTest.lag1RA!.toFixed(2)} · {diffTest.lag1RB!.toFixed(2)}</span></div>
                          <p className="muted small" style={{ marginBottom: 0 }}>
                            OLS slopes with year-to-year-persistence-inflated standard errors,
                            on the {diffTest.n} years both series share; p from Student's t. The
                            test assumes the two regions are independent. Neighbouring regions
                            often share weather, which usually makes it conservative.
                          </p>
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          {fractions && (
            <div className="card">
              <h3>What fraction of Earth is changing?</h3>
              <AreaBar fractions={fractions} />
              <p className="muted small" style={{ marginBottom: 0 }}>
                Fractions of global map area (cos-latitude weighted) after FDR correction across{' '}
                {pack?.nEligible.toLocaleString()} eligible cells. Same test family = one
                variable × one map × one window × one season.
              </p>
            </div>
          )}

          <div className="card">
            <h3>&#8596; Opposite trends</h3>
            <p className="muted small" style={{ marginTop: 0 }}>
              One process can push a variable up in one region and down in another. Find
              the strongest preset-region pair moving in opposite directions for{' '}
              {variable.short_name} ({cat.seasons[store.season].label}, {windowMeta.label}).
            </p>
            <button className="ghost" onClick={runContrastFinder}>Find opposite trends</button>
            {contrasts && contrasts.length === 0 && (
              <p className="muted small" style={{ marginBottom: 0 }}>No pair of preset regions shows significant opposite trends for this combination.</p>
            )}
            {contrasts && contrasts.map((c, i) => {
              const name = (id: string) => cat.regions.find((r) => r.id === id)?.name ?? id
              return (
                <div key={i} className="senscell" style={{ marginTop: 8, cursor: 'pointer' }}
                  onClick={() => {
                    useStore.setState({ regionId: c.a, compareRegionId: c.b, customPolygon: null })
                    setContrasts(null)
                  }}>
                  <div><b style={{ color: '#ff9d85' }}>{name(c.a)}</b> {(c.slopeA >= 0 ? '+' : '') + c.slopeA.toFixed(2)}
                    {' vs '}<b style={{ color: '#8db9ff' }}>{name(c.b)}</b> {(c.slopeB >= 0 ? '+' : '') + c.slopeB.toFixed(2)} {variable.trend_units.replace(' per decade', '')}/dec</div>
                  <div className="sl">both individually significant — click to open this pair</div>
                </div>
              )
            })}
          </div>

          {variable.known_divergence && (
            <div className="divergebox">
              <b>Model vs observations.</b> {variable.known_divergence}
            </div>
          )}
          {variable.caution && (
            <div className="cautionbox"><b>Caution.</b> {variable.caution}</div>
          )}
        </div>
      </div>

      {/* ---------------- lower tabs ---------------- */}
      <div className="container" style={{ paddingTop: 0 }}>
        <div className="card">
          <div className="tabs no-print">
            {(['series', 'sensitivity', 'exploratory', 'methods', 'export'] as const).map((t) => (
              <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {t === 'series' ? 'Time series' : t === 'sensitivity' ? 'Sensitivity' : t === 'exploratory' ? 'Exploratory events' : t === 'methods' ? 'Methods & data' : 'Export evidence'}
              </button>
            ))}
          </div>

          {tab === 'series' && analysis && (
            <>
              <div className="seg no-print" style={{ marginBottom: 10 }}>
                {(['annual', 'monthly', 'deseasonalised'] as const).map((m) => (
                  <button key={m} className={monthlyMode === m ? 'on' : ''}
                    onClick={() => setMonthlyMode(m)}>
                    {m === 'annual' ? 'Annual + trend' : m === 'monthly' ? 'Raw monthly' : 'Cycle removed'}
                  </button>
                ))}
              </div>
              {monthlyMode !== 'annual' && presets && !isMissionVar && store.regionId !== 'custom' && (
                (() => {
                  const entry = monthlyPresets?.[seriesKey]?.[store.regionId]
                  if (!entry) return null
                  return <MonthlyChart months={entry.months} values={entry.values}
                    mode={monthlyMode} units={variable.units} color="#4f9cf9"
                    regionName={region?.name ?? store.regionId} />
                })()
              )}
              {monthlyMode === 'annual' && (
              <>
              <TrendChart
                analysis={analysis}
                label={`${variable.short_name} · ${store.regionId === 'custom' ? 'custom' : region?.name}`}
                color="#4f9cf9"
                units={variable.units}
                compare={compareAnalysis && cmpRegionMeta ? {
                  analysis: compareAnalysis,
                  label: `${variable.short_name} · ${cmpRegionMeta.name}`,
                  color: '#ffb547',
                } : undefined}
                emergence={diag?.emergenceMarker}
                changePoint={diag?.changeMarker}
              />
              {diag?.emergenceMarker && (
                <p className="small" style={{ margin: '8px 0 0' }}>
                  <b style={{ color: '#4cc38a' }}>│ Green line — time of emergence.</b>{' '}
                  <span className="muted">{diag.emSentence}</span>
                </p>
              )}
              {diag?.changeMarker && diag.cpVisible && (
                <p className="small" style={{ margin: '6px 0 0' }}>
                  <b style={{ color: '#ffb547' }}>┆ Dashed amber line — {changePointLabel(diag.pt)}.</b>{' '}
                  <span className="muted">{changePointExplain(diag.pt, variable.units)}</span>
                </p>
              )}
              <p className="muted small" style={{ marginBottom: 0 }}>
                Dashed line: Sen's slope fit; shaded band: its {Math.round(cat.methods!.confidence_level * 100)}% confidence
                interval. Solid lines: cos-latitude weighted regional means of each grid cell's{' '}
                {store.season === 'annual' ? 'annual' : cat.seasons[store.season].label.toLowerCase()} values.
                {store.regionId === 'custom' && ' Custom regions are fetched live from NASA POWER when you draw them.'}
              </p>
              </>
              )}
              {variable.id === 'PRECTOTCORR' && gpcp && presets && store.regionId !== 'custom' && (
                <div style={{ marginTop: 14 }}>
                  <GpcpPanel gpcp={gpcp} regionId={store.regionId}
                    regionName={region?.name ?? ''} cfg={cfg}
                    presets={presets} windowStart={windowMeta.start} windowEnd={windowMeta.end} />
                </div>
              )}
              {presets && store.regionId !== 'custom' && variable && (
                <CrossCheckPanel variable={variable} allVars={allVars} regionId={store.regionId}
                  regionName={region?.name ?? ''} presets={presets} missions={missions} cfg={cfg}
                  windowStart={windowMeta.start} windowEnd={windowMeta.end} />
              )}
            </>
          )}

          {tab === 'sensitivity' && cfg && (
            <SensitivityPanel cat={cat} variable={variable}
              regionId={store.regionId} customPolygon={store.customPolygon} cfg={cfg} />
          )}

          {tab === 'exploratory' && store.regionId !== 'custom' && (
            <AnomalyPanel variableId={store.variableId} regionId={store.regionId}
              season={store.season} windowId={store.windowId} />
          )}

          {tab === 'methods' && <MethodsPanel cat={cat} />}

          {tab === 'export' && analysis && (
            <ExportPanel
              cat={cat}
              variable={variable}
              regionName={store.regionId === 'custom' ? 'Custom region' : region?.name ?? 'region'}
              polygon={polygon}
              windowMeta={windowMeta}
              seasonLabel={cat.seasons[store.season].label}
              analysis={analysis}
              pack={pack}
              compare={compareAnalysis && cmpRegionMeta ? {
                name: cmpRegionMeta.name,
                analysis: compareAnalysis,
              } : undefined}
            />
          )}
        </div>
      </div>
    </>
  )
}

function AreaBar({ fractions }: { fractions: Record<string, number> }) {
  const items: [string, string, string][] = [
    ['detected-increase', '#e1694b', 'detected increase'],
    ['detected-decrease', '#4f7fd8', 'decrease'],
    ['no-detected-trend', '#3a465e', 'no detected trend'],
    ['insufficient-data', '#20242c', 'insufficient'],
  ]
  return (
    <>
      <div className="areabar">
        {items.map(([k, color]) => (
          <div key={k} style={{ width: `${(fractions[k] ?? 0) * 100}%`, background: color }} />
        ))}
      </div>
      <div className="areabar-leg">
        {items.map(([k, , label]) => (
          <span key={k}><b>{((fractions[k] ?? 0) * 100).toFixed(1)}%</b> {label}</span>
        ))}
      </div>
    </>
  )
}

function RegionStat({ name, summary, variable, color }: {
  name: string
  summary?: { n: number; label: string }
  variable: { trend_units: string }
  color: string
}) {
  const s = summary as (Summarized | { n: number; label: string }) | undefined
  if (!s) return null
  const lt = LABEL_TEXT[s.label] ?? { text: s.label, cls: 'pill-none' }
  return (
    <div className="statrow">
      <span className="k" style={{ color }}>{name}</span>
      <span className="v">
        {lt.text}
        {'senSlope' in s && s.senSlope !== undefined && (
          <> · {(s.senSlope * 10 >= 0 ? '+' : '') + (s.senSlope * 10).toFixed(2)} {variable.trend_units}</>
        )}
      </span>
    </div>
  )
}

function HoverTooltip({ hover, trends }: {
  hover: { lon: number; lat: number; pixelIdx: number } | null
  trends: TrendPack | null
}) {
  if (!hover || !trends) return null
  const p = hover.pixelIdx
  const code = trends.label[p] & 0x7f
  const caution = (trends.label[p] & 0x80) !== 0
  const names = ['detected-increase', 'detected-decrease', 'no-detected-trend', 'insufficient-data']
  const lt = LABEL_TEXT[names[code]] ?? { text: names[code], cls: 'pill-none' }
  const slope10 = trends.slope[p] * 10
  return (
    <div className="tooltip" style={{ left: 10, top: 10 }}>
      <div className="mono muted">{hover.lat >= 0 ? hover.lat.toFixed(2) + '°N' : (-hover.lat).toFixed(2) + '°S'}{' '}
        {hover.lon >= 0 ? hover.lon.toFixed(2) + '°E' : (-hover.lon).toFixed(2) + '°W'}</div>
      <div><span className={`pill ${lt.cls}`}>{lt.text}</span></div>
      {Number.isFinite(slope10) && (
        <div className="mono">
          slope {(slope10 >= 0 ? '+' : '') + slope10.toFixed(3)} per decade
          <br />
          <span className="muted">
            CI [{(trends.ciLow[p] * 10).toFixed(3)}, {(trends.ciHigh[p] * 10).toFixed(3)}]
          </span>
          {Number.isFinite(trends.fdrP[p]) && (
            <>
              <br />
              <span className="muted">FDR p ≈ {trends.fdrP[p].toPrecision(3)}</span>
            </>
          )}
        </div>
      )}
      {caution && <div className="small" style={{ color: 'var(--warn)' }}>⚠ interpretation caution</div>}
      {(trends.label[p] & 0x40) !== 0 && !(code === 0 || code === 1) && (
        <div className="small" style={{ color: '#ffd39a' }}>amber: naive test only — persistence adjustment removed it</div>
      )}
      <div className="muted small">Map cells: FDR-corrected decisions.</div>
    </div>
  )
}

function MethodsPanel({ cat }: { cat: Catalog }) {
  return (
    <div className="grid2">
      <div>
        <h3>Statistical method</h3>
        <p className="muted small">
          <b>Trend magnitude</b> — Sen's slope: the median of all pairwise slopes between
          years, robust to outliers, computed against real calendar years.
          <br /><br />
          <b>Significance</b> — Mann-Kendall test (normal approximation with tie and
          continuity corrections) at α = {cat.methods!.alpha}. An OLS slope t-test runs as a
          second opinion; disagreements trigger an “interpretation caution” flag.
          <br /><br />
          <b>Uncertainty</b> — Gilbert's {Math.round(cat.methods!.confidence_level * 100)}% confidence
          interval for the Sen slope.
          <br /><br />
          <b>Map multiplicity</b> — {cat.methods!.fdr_note}
        </p>
      </div>
      <div>
        <h3>Data &amp; provenance</h3>
        <p className="muted small">
          <b>Primary</b> — NASA POWER monthly regional API, source-native MERRA-2 grid
          (0.5° × 0.625°), Jan 1981 – Dec 2025, worldwide ({cat.n_cells.toLocaleString()} grid
          cells). MERRA-2 is NASA GMAO's satellite-constrained reanalysis; the challenge
          statement explicitly names MERRA-2. Global maps are precomputed with the
          validated Python engine; regional verdicts and any region you draw are computed
          live in your browser — for drawn regions, the monthly data is fetched directly
          from NASA POWER at that moment.
          <br /><br />
          <b>Observed cross-check</b> — GPCP V2.3 combined satellite–gauge precipitation
          (NOAA PSL), 2.5°, for precipitation variables.
          <br /><br />
          <b>Aggregation</b> — annual means are day-count-weighted; totals are built from
          mm/day rates × actual days per month; a year counts only when enough months are
          present (means ≥80%, totals and seasons 100%). Missing months are never zero.
          <br /><br />
          <b>Regions</b> — a cell belongs to a region when its centre lies inside the polygon;
          regional means weight cells by cos(latitude) (real Earth-area weighting).
          <br /><br />
          Full provenance, including fetch timestamps, ships in every export.
        </p>
      </div>
    </div>
  )
}
