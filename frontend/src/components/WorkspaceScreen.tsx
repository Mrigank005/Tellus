import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { place, seasonPhrase, spanPhrase } from '../state/places'
import { useTheme } from '../state/theme'
import { tokens } from '../styles/tokens'
import { Icon, type IconName } from './Icon'
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
import MapCanvas, { MapLegend, slopeVmax, type MapHover } from './MapCanvas'
import TrendChart from './TrendChart'
import SensitivityPanel from './SensitivityPanel'
import ExportPanel from './ExportPanel'
import GpcpPanel from './GpcpPanel'
import CrossCheckPanel from './CrossCheckPanel'
import AnomalyPanel from './AnomalyPanel'
import StoryPanel from './journey/StoryPanel'
import RigorPanel from './journey/RigorPanel'
import { sourceFor, useJourneyVerdict } from './journey/StoryVerdict'

/** Verdict stamps: shape plus words, never colour alone. `title` carries the full phrase. */
const STAMP: Record<string, { text: string; cls: string; icon: IconName; title: string }> = {
  'detected-increase': { text: 'Detected increase', cls: 'up', icon: 'check', title: 'Statistically detected increase' },
  'detected-decrease': { text: 'Detected decrease', cls: 'down', icon: 'check', title: 'Statistically detected decrease' },
  'no-detected-trend': { text: 'No clear trend', cls: 'none', icon: 'tilde', title: 'No statistically detected trend' },
  'insufficient-data': { text: 'Too little data', cls: 'na', icon: 'x', title: 'Insufficient data' },
}

type Tab = 'story' | 'real' | 'series' | 'sensitivity' | 'exploratory' | 'methods' | 'export'

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
  const theme = useTheme((s) => s.theme)
  const tk = tokens(theme)
  // stable, so the map's drawing handlers are not re-bound on every hover update
  const onDrawn = useCallback((poly: number[][]) => {
    const st = useStore.getState()
    st.setRegion('custom', poly)
    st.setDrawing(false)
  }, [])
  const [cat, setCat] = useState<Catalog | null>(null)
  const [grid, setGrid] = useState<Grid | null>(null)
  const [pack, setPack] = useState<TrendPack | null>(null)
  const [analysis, setAnalysis] = useState<RegionAnalysis | null>(null)
  // why there is no analysis (dataset not covering the region, etc.), so the
  // card never keeps showing the previous variable's verdict
  const [noData, setNoData] = useState<string | null>(null)
  const [compareAnalysis, setCompareAnalysis] = useState<RegionAnalysis | null>(null)
  const [gpcp, setGpcp] = useState<GpcpData | null>(null)
  const [presets, setPresets] = useState<Presets | null>(null)
  const [missions, setMissions] = useState<Missions | null>(null)
  const [missionVars, setMissionVars] = useState<MissionVariable[]>([])
  const [busy, setBusy] = useState(true)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [hover, setHover] = useState<MapHover | null>(null)
  const [showSignificance, setShowSignificance] = useState(true)
  // a comparison is best read on the shared time-series chart; one place opens on its story
  const [tab, setTab] = useState<Tab>(() => (useStore.getState().compareRegionId ? 'series' : 'story'))
  const compareId = store.compareRegionId
  useEffect(() => { if (compareId) setTab('series') }, [compareId])
  // the same verdict the journey reads, so the story and the shuffle test always agree with it
  const { v: storyV, pending: storyPending } = useJourneyVerdict()
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
      const isMission = (variable as VariableMeta & { has_global_map?: boolean }).has_global_map === false
      if (isMission && !missions) return  // satellite series still loading
      if (store.regionId === 'custom' && store.customPolygon && isMission) {
        setAnalysis(null)
        setNoData(`Drawing a region fetches NASA POWER (MERRA-2) data live, so it works with the MERRA-2 `
          + `variables only. ${variable.short_name} comes from ${(variable as VariableMeta & { instrument?: string }).instrument ?? 'another source'}; `
          + `pick one of the preset regions to see it.`)
      } else if (store.regionId === 'custom' && store.customPolygon) {
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
          if (!cancelled) {
            setAnalysis({ ...a, coverage: Math.min(...rs.nValid) / Math.max(1, rs.nCells) })
            setNoData(null)
          }
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
        if (cancelled) return  // a newer selection has started; never overwrite it
        if (entry) {
          setAnalysis(regionAnalysis(entry.years, entry.values, entry.n_cells, win, cfg))
          setNoData(null)
        } else {
          setAnalysis(null)
          const covered = isMission
            ? cat.regions.filter((r) => missions?.[variable.id]?.[store.season]?.[r.id]).map((r) => r.name)
            : []
          setNoData(`${variable.short_name} has no record for ${region?.name ?? 'this region'}`
            + (store.season !== 'annual' ? ' in this season' : '') + '. '
            + (covered.length
              ? `This dataset covers: ${covered.join(', ')}.`
              : 'Try another region or season.'))
        }
      }
      // Region B (presets only)
      if (store.compareRegionId && store.compareRegionId !== 'custom') {
        const mKey = (variable as VariableMeta & { has_global_map?: boolean }).has_global_map === false
          ? variable.id : variable.power_parameter
        const entry = await getSeriesEntry(mKey, store.season, store.compareRegionId, presets, missions)
        if (cancelled) return
        setCompareAnalysis(entry ? regionAnalysis(entry.years, entry.values, entry.n_cells, win, cfg) : null)
      } else {
        setCompareAnalysis(null)
      }
    }
    run()
    return () => { cancelled = true }
  }, [cat, cfg, variable, windowMeta, presets, missions, store.regionId,
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

  const seasonShort = (id: string) => seasonPhrase(id, cat.seasons[id]?.label)
  const windowShort = (id: string) => spanPhrase(cat.windows.find((w) => w.id === id))
  const regionName = store.regionId === 'custom' ? 'Custom region' : region?.name ?? 'this region'
  const regionMid = place(store.regionId, region?.name).mid
  const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)
  const isMissionOpt = (v: VariableMeta) => (v as VariableMeta & { source_type?: string }).source_type === 'mission'
  const instrument = (variable as VariableMeta & { instrument?: string }).instrument
  const stamp = summary ? STAMP[summary.label] : undefined
  const hasSlope = !!summary && summary.label !== LABELS.insufficientData && 'senSlope' in summary
  const sourceBadge = store.regionId === 'custom' && !isMissionVar
    ? 'NASA POWER · live fetch'
    : isMissionVar ? (instrument ?? 'Satellite record') : 'NASA POWER · MERRA-2'

  const tabLabels: Record<Tab, string> = {
    story: 'The story', real: 'Is it real?',
    series: 'Time series', sensitivity: 'Sensitivity', exploratory: 'Exploratory events',
    methods: 'Methods & data', export: 'Export evidence',
  }
  const tabOrder = Object.keys(tabLabels) as Tab[]
  function onTabKey(e: React.KeyboardEvent, t: Tab) {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const next = tabOrder[(tabOrder.indexOf(t) + dir + tabOrder.length) % tabOrder.length]
    setTab(next)
    document.getElementById(`desk-tab-${next}`)?.focus()
  }

  return (
    <div className="desk">
      {/* ---------------- the question ---------------- */}
      <section className="desk-bar" aria-label="The question you are asking">
        <div className="desk-q">
          <span>How has</span>
          <ChipSelect label="Variable" value={store.variableId} onChange={(v) => store.setVariable(v)}
            display={lowerFirst(variable.short_name)}>
            {allVars.map((v) => (
              <option key={v.id} value={v.id} title={v.long_name}>
                {v.short_name}{isMissionOpt(v) ? ' (satellite)' : ''}
              </option>
            ))}
          </ChipSelect>
          <span>changed in</span>
          <ChipSelect label="Region" value={store.regionId} onChange={(v) => store.setRegion(v)}
            display={regionMid} swatch="var(--copper)">
            {store.regionId === 'custom' && <option value="custom">Custom region</option>}
            {cat.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </ChipSelect>
          <ChipSelect label="Season" value={store.season} onChange={(v) => store.setSeason(v)}
            display={seasonShort(store.season)}>
            {Object.entries(cat.seasons).map(([id, s]) => (
              <option key={id} value={id}>{seasonShort(id)}</option>
            ))}
          </ChipSelect>
          <span>over</span>
          <ChipSelect label="Time window" value={store.windowId} onChange={(v) => store.setWindow(v)}
            display={windowShort(store.windowId)}>
            {cat.windows.map((w) => (
              <option key={w.id} value={w.id}>
                {spanPhrase(w)} ({w.start}–{w.end})
              </option>
            ))}
          </ChipSelect>
          <span>?</span>
        </div>
        <div className="desk-tools">
          <span className="desk-cmp">
            <span>Compare with</span>
            <ChipSelect label="Compare with another region" value={store.compareRegionId ?? ''}
              onChange={(v) => store.setCompare(v || null)}
              display={cmpRegionMeta ? place(cmpRegionMeta.id, cmpRegionMeta.name).mid : 'another place'} swatch={cmpRegionMeta ? 'var(--leaf)' : undefined}>
              <option value="">No comparison</option>
              {cat.regions.filter((r) => r.id !== store.regionId).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </ChipSelect>
          </span>
          <span className="spacer" />
          <button className="btn ghost sm" aria-pressed={store.drawing}
            onClick={() => store.setDrawing(!store.drawing)}>
            <Icon name="pen" />
            {store.drawing ? 'Click two opposite corners on the map…' : 'Draw a region'}
          </button>
          <button className="btn ghost sm" onClick={() => store.go('configure')}>
            Change the question
          </button>
        </div>
      </section>

      <div className="desk-grid">
        {/* ---------------- map ---------------- */}
        <section className="desk-map" aria-label="Map of trends">
          <div className="desk-stage">
            <MapCanvas
              grid={grid ?? { lats: new Float64Array(0), lons: new Float64Array(0) }}
              domain={cat.domain}
              trends={pack}
              showSignificance={showSignificance}
              regionA={polygon}
              regionB={cmpRegionMeta?.polygon ?? null}
              drawing={store.drawing}
              onDrawn={onDrawn}
              onHover={setHover}
              trendUnits={variable.trend_units}
              regionVerdicts={regionVerdicts}
            />
            {!isMissionVar && (
              <button className="map-tool" aria-pressed={showSignificance}
                onClick={() => setShowSignificance((v) => !v)}>
                Significance shading: {showSignificance ? 'on' : 'off'}
              </button>
            )}
            {store.drawing && (
              <div className="map-hint" role="status">Click two opposite corners, or drag a box.</div>
            )}
            {busy && (
              <div className="desk-loading" role="status">
                <div className="spinner" /> Loading trend map…
              </div>
            )}
            {liveStatus && (
              <div className="desk-loading" role="status">
                <div className="spinner" /> {liveStatus}
              </div>
            )}
            <HoverTooltip hover={hover} trends={pack} />
          </div>
          <MapLegend vmaxPerDecade={vmaxPerDecade || 1} trendUnits={variable.trend_units}
            showSignificance={showSignificance} regionLevel={isMissionVar} />
        </section>

        {/* ---------------- side column ---------------- */}
        <aside className="desk-side" aria-label="Verdict and notes">
          <article className="specimen" aria-labelledby="sp-place">
            <Icon name="pin" className="pin" />
            <h2 id="sp-place">{regionName}</h2>
            <div className="what">
              {variable.long_name} · {cat.seasons[store.season].label.split(' (')[0]} · {windowMeta.label}
            </div>
            {summary ? (
              <>
                <div className="sp-stamp">
                  <span className={`stamp ${stamp?.cls ?? 'none'}`} title={stamp?.title}>
                    <Icon name={stamp?.icon ?? 'tilde'} /><span>{stamp?.text ?? summary.label}</span>
                  </span>
                </div>
                {hasSlope && (
                  <>
                    <div className="big">
                      {signed(slopeDec, 2)}<small>{variable.trend_units}</small>
                    </div>
                    <div className="ci">
                      Likely between <span className="num">{signed(ciLowDec, 2)}</span> and{' '}
                      <span className="num">{signed(ciHighDec, 2)}</span> (95% interval)
                    </div>
                  </>
                )}
                {analysis && 'senSlope' in summary && (
                  <p className="plain">
                    {plainVerdict(summary as SummT, variable.trend_units, variable.higher_means, analysis.years)}
                  </p>
                )}
                {diag && diag.em.status !== 'insufficient-data' && summary.label !== LABELS.insufficientData && (
                  <p className="sp-p">{diag.emSentence}</p>
                )}
                {horizon && (
                  <div className="cautionbox">
                    <b>Not significant — yet?</b> {plainHorizon(horizon.moreYears, horizon.cappedAt)}
                  </div>
                )}
                {naiveDiffers && (
                  <div className="cautionbox">
                    <b>Naive test would have called this significant.</b> Adjusting for
                    year-to-year persistence (lag-1 r ≈ {'lag1R' in (summary as object) ? ((summary as any).lag1R).toFixed(2) : '—'},
                    effective n ≈ {'nEff' in (summary as object) ? Math.round((summary as any).nEff) : '—'}) moves the
                    p-value from {(summary as any).mkP.toPrecision(2)} to {(summary as any).mkPAdj.toPrecision(2)}.
                  </div>
                )}
                {summary.label !== LABELS.insufficientData && 'caution' in summary && summary.caution && (
                  <div className="cautionbox">
                    <b>Interpretation caution.</b> {summary.cautionReasons.join('; ')}.
                  </div>
                )}
                <dl className="facts">
                  {diag?.em.status === 'emerged' && diag.em.emergenceYear !== null && (
                    <><dt>Clear since</dt><dd>{diag.em.emergenceYear}</dd></>
                  )}
                  {diag?.cpVisible && diag.pt.year != null && (
                    <><dt>Possible shift</dt><dd>around {diag.pt.year}</dd></>
                  )}
                  <dt>Years used</dt><dd>{summary.n}</dd>
                  <dt>Grid cells</dt><dd>{analysis?.series.nCells ?? '—'}</dd>
                  <dt>Data coverage</dt><dd>{(analysis ? analysis.coverage * 100 : NaN).toFixed(0)}%</dd>
                  {store.regionId === 'custom' && (<><dt>Data source</dt><dd>live NASA POWER fetch</dd></>)}
                </dl>
                <details className="stats">
                  <summary>Show the statistics</summary>
                  <div className="statrows">
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
            ) : noData ? (
              <>
                <div className="sp-stamp">
                  <span className="stamp na"><Icon name="x" /><span>No record here</span></span>
                </div>
                <div className="cautionbox">{noData}</div>
              </>
            ) : (
              <p className="note" role="status">Computing…</p>
            )}
            <div className="sp-sources">
              {(() => {
                const src = sourceFor(variable as Parameters<typeof sourceFor>[0])
                return (
                  <a className="source" href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>
                    <Icon name="sat" />{store.regionId === 'custom' && !isMissionVar ? sourceBadge : src.label}
                  </a>
                )
              })()}
              <span className="source" title="Statistics computed on this page"><Icon name="rings" />Computed in your browser</span>
            </div>
          </article>

          {cmpSummary && compareAnalysis && (() => {
            const nameA = regionName
            const nameB = cmpRegionMeta?.name ?? 'B'
            const rel = polygon && cmpRegionMeta
              ? regionRelation(polygon, cmpRegionMeta.polygon) : 'separate'
            const overlapping = rel !== 'separate'
            const unitsShort = variable.trend_units.replace(' per decade', '')
            return (
              <section className="desk-card" aria-labelledby="cmp-h">
                <h3 id="cmp-h">Compared with {nameB}</h3>
                <div className="ledger">
                  <RegionStat name={nameA} summary={summary} variable={variable} swatch="var(--copper)" />
                  <RegionStat name={nameB} summary={cmpSummary} variable={variable} swatch="var(--leaf)" />
                </div>
                {diffTest && (
                  <div className="cmp-result">
                    <div className="cmp-head">
                      {differenceHeadline(diffTest, overlapping)}
                    </div>
                    {overlapping && diffTest.label !== 'insufficient-data' && (
                      <div className="cautionbox">
                        <b>These regions overlap, so the test is approximate.</b>{' '}
                        {relationText(rel, nameA, nameB)}: the two series share the same
                        grid cells, so they are not independent samples. Treat the result
                        as a rough guide, not a clean verdict.
                      </div>
                    )}
                    <p className="sp-p">
                      {differenceDetail(diffTest, unitsShort)}
                    </p>
                    {diffTest.label !== 'insufficient-data' && (
                      <details className="stats">
                        <summary>Show the statistics</summary>
                        <div className="statrows">
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
                          <p className="note">
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
              </section>
            )
          })()}

          {fractions && (
            <section className="desk-card" aria-labelledby="frac-h">
              <h3 id="frac-h">What fraction of Earth is changing?</h3>
              <AreaBar fractions={fractions} />
              <p className="note">
                Fractions of global map area (cos-latitude weighted) after FDR correction across{' '}
                {pack?.nEligible.toLocaleString()} eligible cells. Same test family = one
                variable × one map × one window × one season.
              </p>
            </section>
          )}

          <section className="desk-card" aria-labelledby="opp-h">
            <h3 id="opp-h">Opposite trends</h3>
            <p className="note">
              One process can push a variable up in one region and down in another. Find
              the strongest preset-region pair moving in opposite directions for{' '}
              {variable.short_name} ({cat.seasons[store.season].label}, {windowMeta.label}).
            </p>
            <button className="btn ghost sm" onClick={runContrastFinder}>Find opposite trends</button>
            {contrasts && contrasts.length === 0 && (
              <p className="note" role="status">No pair of preset regions shows significant opposite trends for this combination.</p>
            )}
            {contrasts && contrasts.length > 0 && (
              <ul className="pairs">
                {contrasts.map((c, i) => {
                  const name = (id: string) => cat.regions.find((r) => r.id === id)?.name ?? id
                  const cls = (x: number) => (x >= 0 ? 'up' : 'down')
                  return (
                    <li key={i}>
                      <button className="pair" onClick={() => {
                        useStore.setState({ regionId: c.a, compareRegionId: c.b, customPolygon: null })
                        setContrasts(null)
                      }}>
                        <span className="pair-line">
                          <b className={cls(c.slopeA)}>{name(c.a)}</b> <span className="num">{signed(c.slopeA, 2)}</span>
                          {' vs '}
                          <b className={cls(c.slopeB)}>{name(c.b)}</b> <span className="num">{signed(c.slopeB, 2)}</span>{' '}
                          {variable.trend_units.replace(' per decade', '')}/dec
                        </span>
                        <span className="pair-sub">Both individually significant. Open this pair.</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {variable.known_divergence && (
            <div className="divergebox">
              <b>Model vs observations.</b> {variable.known_divergence}
            </div>
          )}
          {variable.caution && (
            <div className="cautionbox"><b>Caution.</b> {variable.caution}</div>
          )}
        </aside>

        {/* ---------------- tabs ---------------- */}
        <section className="desk-lower" aria-label="Analysis">
          <div className="desk-tablist no-print" role="tablist" aria-label="Analysis panels">
            {tabOrder.map((t) => (
              <button key={t} id={`desk-tab-${t}`} role="tab" aria-selected={tab === t}
                aria-controls="desk-tabpanel" tabIndex={tab === t ? 0 : -1}
                className={`desk-tab ${tab === t ? 'on' : ''}`}
                onClick={() => setTab(t)} onKeyDown={(e) => onTabKey(e, t)}>
                {tabLabels[t]}
              </button>
            ))}
          </div>

          <div className="desk-tabpanel" id="desk-tabpanel" role="tabpanel" aria-labelledby={`desk-tab-${tab}`}>
            {tab === 'story' && (
              storyV && !storyPending && storyV.status === 'ready' ? (
                <StoryPanel v={storyV} />
              ) : storyV && !storyPending ? (
                <p className="note">
                  {storyV.status === 'custom'
                    ? 'The story reads the stored record of the preset places. For a region you draw, the verdict beside the map and the Time series tab show the same tests on the live NASA POWER data.'
                    : storyV.message ?? 'There is no record to tell a story from for this question.'}
                </p>
              ) : (
                <p className="note" role="status">Reading the record…</p>
              )
            )}
            {tab === 'real' && (
              storyPending && !storyV ? <p className="note" role="status">Reading the record…</p> : (
                <>
                  <p className="note desk-real-intro">
                    A run of unusual years can happen by luck. Shuffle the years: if their order did not matter,
                    a real trend would show up in the shuffled records too. Then compare the three ways of testing.
                  </p>
                  <RigorPanel
                    v={storyPending ? null : storyV}
                    customNote="The shuffle test reads the stored record of the preset places. For a region you draw, the verdict beside the map already uses the corrected test."
                  />
                </>
              )
            )}
            {tab === 'series' && !analysis && (
              <p className="note">{noData ?? 'The time series appears here once the region has been analysed.'}</p>
            )}
            {tab === 'series' && analysis && (
              <>
                <div className="desk-series-head">
                  <div className="seg no-print">
                    {(['annual', 'monthly', 'deseasonalised'] as const).map((m) => (
                      <button key={m} className={monthlyMode === m ? 'on' : ''} aria-pressed={monthlyMode === m}
                        onClick={() => setMonthlyMode(m)}>
                        {m === 'annual' ? 'Annual + trend' : m === 'monthly' ? 'Raw monthly' : 'Cycle removed'}
                      </button>
                    ))}
                  </div>
                  <span className="desk-badges">
                    {(() => {
                      const src = sourceFor(variable as Parameters<typeof sourceFor>[0])
                      return store.regionId === 'custom' && !isMissionVar
                        ? <a className="source" href="https://power.larc.nasa.gov/" target="_blank" rel="noopener noreferrer" title="Fetched live from the NASA POWER API for the region you drew"><Icon name="sat" />NASA POWER · live fetch</a>
                        : <a className="source" href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}><Icon name="sat" />{src.label}</a>
                    })()}
                    <span className="source" title="The statistics are calculated on this page, not on a server"><Icon name="rings" />Computed in your browser</span>
                  </span>
                </div>
                {monthlyMode !== 'annual' && presets && !isMissionVar && store.regionId !== 'custom' && (
                  (() => {
                    const entry = monthlyPresets?.[seriesKey]?.[store.regionId]
                    if (!entry) return null
                    return <MonthlyChart months={entry.months} values={entry.values}
                      mode={monthlyMode} units={variable.units} color={tk.ink}
                      regionName={region?.name ?? store.regionId} />
                  })()
                )}
                {monthlyMode === 'annual' && (
                  <>
                    <TrendChart
                      analysis={analysis}
                      label={`${variable.short_name} · ${store.regionId === 'custom' ? 'custom' : region?.name}`}
                      color={tk.ink}
                      units={variable.units}
                      compare={compareAnalysis && cmpRegionMeta ? {
                        analysis: compareAnalysis,
                        label: `${variable.short_name} · ${cmpRegionMeta.name}`,
                        color: tk.leaf,
                      } : undefined}
                      emergence={diag?.emergenceMarker}
                      changePoint={diag?.changeMarker}
                    />
                    {diag?.emergenceMarker && (
                      <p className="key-line">
                        <span className="key-mark solid" aria-hidden="true" />
                        <b style={{ color: 'var(--leaf)' }}>Solid green line: time of emergence.</b>{' '}
                        <span className="muted">{diag.emSentence}</span>
                      </p>
                    )}
                    {diag?.changeMarker && diag.cpVisible && (
                      <p className="key-line">
                        <span className="key-mark dashed" aria-hidden="true" />
                        <b style={{ color: 'var(--copper)' }}>Dashed copper line: {changePointLabel(diag.pt)}.</b>{' '}
                        <span className="muted">{changePointExplain(diag.pt, variable.units)}</span>
                      </p>
                    )}
                    <p className="note">
                      Dashed line: Sen's slope fit; shaded band: its {Math.round(cat.methods!.confidence_level * 100)}% confidence
                      interval. Solid lines: cos-latitude weighted regional means of each grid cell's{' '}
                      {store.season === 'annual' ? 'annual' : cat.seasons[store.season].label.toLowerCase()} values.
                      {store.regionId === 'custom' && ' Custom regions are fetched live from NASA POWER when you draw them.'}
                    </p>
                  </>
                )}
                {variable.id === 'PRECTOTCORR' && gpcp && presets && store.regionId !== 'custom' && (
                  <div style={{ marginTop: 16 }}>
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
            {tab === 'exploratory' && store.regionId === 'custom' && (
              <p className="note">Event diagnostics are prepared for the preset regions. Pick a preset region to see them.</p>
            )}

            {tab === 'methods' && <MethodsPanel cat={cat} />}

            {tab === 'export' && !analysis && (
              <p className="note">{noData ?? 'There is nothing to export yet. Choose a region with a record, and the evidence package appears here.'}</p>
            )}
            {tab === 'export' && analysis && (
              <ExportPanel
                cat={cat}
                variable={variable}
                regionName={regionName === 'this region' ? 'region' : regionName}
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
        </section>
      </div>
    </div>
  )
}

/** "+0.46" / "−0.12" with a true minus sign; formatting only. */
function signed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return '—'
  const s = x.toFixed(digits)
  return x >= 0 ? `+${s}` : s.replace('-', '−')
}

/** A native select dressed as an inline choice chip in the question sentence. */
function ChipSelect({ label, value, onChange, display, swatch, children }: {
  label: string
  value: string
  onChange: (v: string) => void
  display: string
  swatch?: string
  children: React.ReactNode
}) {
  return (
    <span className="dchip">
      {swatch && <span className="dot" style={{ background: swatch }} aria-hidden="true" />}
      <span className="dchip-val">{display}</span>
      <Icon name="chev" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </span>
  )
}

function AreaBar({ fractions }: { fractions: Record<string, number> }) {
  const items: [string, string, string][] = [
    ['detected-increase', 'inc', 'Detected increase'],
    ['detected-decrease', 'dec', 'Detected decrease'],
    ['no-detected-trend', 'none', 'No clear trend'],
    ['insufficient-data', 'few', 'Too little data'],
  ]
  return (
    <>
      <div className="areabar" role="img"
        aria-label={items.map(([k, , label]) => `${label} ${((fractions[k] ?? 0) * 100).toFixed(1)} percent`).join(', ')}>
        {items.map(([k, cls]) => (
          <div key={k} className={`seg-${cls}`} style={{ width: `${(fractions[k] ?? 0) * 100}%` }} />
        ))}
      </div>
      <ul className="areabar-leg">
        {items.map(([k, cls, label]) => (
          <li key={k}>
            <span className={`swatch sw-${cls}`} aria-hidden="true" />
            <span className="lbl">{label}</span>
            <b className="num">{((fractions[k] ?? 0) * 100).toFixed(1)}%</b>
          </li>
        ))}
      </ul>
    </>
  )
}

function RegionStat({ name, summary, variable, swatch }: {
  name: string
  summary?: { n: number; label: string }
  variable: { trend_units: string }
  swatch: string
}) {
  const s = summary as (Summarized | { n: number; label: string }) | undefined
  if (!s) return null
  const st = STAMP[s.label] ?? { text: s.label, cls: 'none', icon: 'tilde' as IconName, title: s.label }
  return (
    <div className="ledger-row">
      <span className="dot" style={{ background: swatch }} aria-hidden="true" />
      <span className="nm">{name}</span>
      <span className={`stamp sm ${st.cls}`} title={st.title}><Icon name={st.icon} /><span>{st.text}</span></span>
      {'senSlope' in s && s.senSlope !== undefined && (
        <span className="val num">{signed(s.senSlope * 10, 2)} {variable.trend_units}</span>
      )}
    </div>
  )
}

function HoverTooltip({ hover, trends }: {
  hover: MapHover | null
  trends: TrendPack | null
}) {
  if (!hover || !trends) return null
  const p = hover.pixelIdx
  const code = trends.label[p] & 0x3f
  const caution = (trends.label[p] & 0x80) !== 0
  const names = ['detected-increase', 'detected-decrease', 'no-detected-trend', 'insufficient-data']
  const st = STAMP[names[code]] ?? { text: names[code], cls: 'none', icon: 'tilde' as IconName, title: names[code] }
  const slope10 = trends.slope[p] * 10
  // follow the pointer, flipping to the other side near the right and bottom edges
  const x = hover.x ?? 10, y = hover.y ?? 10, w = hover.w ?? 0, h = hover.h ?? 0
  const flipX = w > 0 && x > w - 250, flipY = h > 0 && y > h - 190
  const style: React.CSSProperties = {
    left: flipX ? undefined : x + 14, right: flipX ? w - x + 14 : undefined,
    top: flipY ? undefined : y + 14, bottom: flipY ? h - y + 14 : undefined,
  }
  return (
    <div className="tip desk-tip" style={style} role="status">
      <div className="tip-where num">{hover.lat >= 0 ? hover.lat.toFixed(2) + '°N' : (-hover.lat).toFixed(2) + '°S'}{' '}
        {hover.lon >= 0 ? hover.lon.toFixed(2) + '°E' : (-hover.lon).toFixed(2) + '°W'}</div>
      <div className="tip-verdict">
        <span className={`tip-sw sw-${names[code]}`} aria-hidden="true" />{st.title}
      </div>
      {Number.isFinite(slope10) && (
        <div className="tip-nums num">
          slope {(slope10 >= 0 ? '+' : '') + slope10.toFixed(3)} per decade
          <br />
          <span className="dim">
            CI [{(trends.ciLow[p] * 10).toFixed(3)}, {(trends.ciHigh[p] * 10).toFixed(3)}]
          </span>
          {Number.isFinite(trends.fdrP[p]) && (
            <>
              <br />
              <span className="dim">FDR p ≈ {trends.fdrP[p].toPrecision(3)}</span>
            </>
          )}
        </div>
      )}
      {caution && <div className="tip-note">Interpretation caution</div>}
      {(trends.label[p] & 0x40) !== 0 && !(code === 0 || code === 1) && (
        <div className="tip-note">Naive test only: the persistence adjustment removed it</div>
      )}
      <div className="tip-foot">Map cells: FDR-corrected decisions.</div>
    </div>
  )
}

function MethodsPanel({ cat }: { cat: Catalog }) {
  return (
    <div className="desk-methods">
      <section>
        <h3>Statistical method</h3>
        <p>
          <b>Trend magnitude</b> — Sen's slope: the median of all pairwise slopes between
          years, robust to outliers, computed against real calendar years.
        </p>
        <p>
          <b>Significance</b> — Mann-Kendall test (normal approximation with tie and
          continuity corrections) at α = {cat.methods!.alpha}. An OLS slope t-test runs as a
          second opinion; disagreements trigger an “interpretation caution” flag.
        </p>
        <p>
          <b>Uncertainty</b> — Gilbert's {Math.round(cat.methods!.confidence_level * 100)}% confidence
          interval for the Sen slope.
        </p>
        <p>
          <b>Map multiplicity</b> — {cat.methods!.fdr_note}
        </p>
      </section>
      <section>
        <h3>Data &amp; provenance</h3>
        <p>
          <b>Primary</b> — NASA POWER monthly regional API, source-native MERRA-2 grid
          (0.5° × 0.625°), Jan 1981 – Dec 2025, worldwide ({cat.n_cells.toLocaleString()} grid
          cells). MERRA-2 is NASA GMAO's satellite-constrained reanalysis; the challenge
          statement explicitly names MERRA-2. Global maps are precomputed with the
          validated Python engine; regional verdicts and any region you draw are computed
          live in your browser — for drawn regions, the monthly data is fetched directly
          from NASA POWER at that moment.
        </p>
        <p>
          <b>Observed cross-check</b> — GPCP V2.3 combined satellite–gauge precipitation
          (NOAA PSL), 2.5°, for precipitation variables.
        </p>
        <p>
          <b>Aggregation</b> — annual means are day-count-weighted; totals are built from
          mm/day rates × actual days per month; a year counts only when enough months are
          present (means ≥80%, totals and seasons 100%). Missing months are never zero.
        </p>
        <p>
          <b>Regions</b> — a cell belongs to a region when its centre lies inside the polygon;
          regional means weight cells by cos(latitude) (real Earth-area weighting).
        </p>
        <p>Full provenance, including fetch timestamps, ships in every export.</p>
      </section>
    </div>
  )
}
