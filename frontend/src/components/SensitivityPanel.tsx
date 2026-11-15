import { Fragment, useEffect, useMemo, useState } from 'react'
import type { Catalog, MissionVariable, VariableMeta } from '../engine/loader'
import { getSeriesEntry, loadMissions, loadPresets } from '../engine/loader'
import { regionAnalysis, type AnalysisConfig } from '../engine/analysis'
import type { Summarized } from '../engine/stats'
import { fetchLiveMonthly, liveSeason, peekLive, type BBox } from '../engine/powerLive'
import { regionSeries } from '../engine/geography'
import { useStore } from '../state/store'
import WindowHeatmap from './WindowHeatmap'
import { Icon } from './Icon'

interface Source { years: number[]; values: (number | null)[]; nCells: number }

/** Does the story survive the analysis choices? Two views: every start-year x
 * end-year window for the selected season (heat map + robustness verdict),
 * and the standard windows across all seasons (compact table). */
export default function SensitivityPanel({ cat, variable, regionId, customPolygon, cfg }: {
  cat: Catalog
  variable: VariableMeta
  regionId: string
  customPolygon: number[][] | null
  cfg: AnalysisConfig
}) {
  const store = useStore()
  const region = cat.regions.find((r) => r.id === regionId)
  const [view, setView] = useState<'windows' | 'seasons'>('windows')
  const [sources, setSources] = useState<Record<string, Source | null> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)

    const bbox = (poly: number[][]): BBox => {
      let a = 180, b = -180, c = 90, d = -90
      for (const [lo, la] of poly) {
        a = Math.min(a, lo); b = Math.max(b, lo); c = Math.min(c, la); d = Math.max(d, la)
      }
      return { lonMin: a, lonMax: b, latMin: c, latMax: d }
    }

    const run = async () => {
      try {
        const perSeason: Record<string, Source | null> = {}
        if (regionId === 'custom' && customPolygon) {
          const live = peekLive(variable.power_parameter, bbox(customPolygon))
            ?? await fetchLiveMonthly(variable.power_parameter, bbox(customPolygon))
          for (const season of Object.keys(cat.seasons)) {
            const s = liveSeason(live, season, variable.aggregation, cat.seasons)
            const nYears = s.years.length
            const rs = regionSeries(Float32Array.from(s.values), Float64Array.from(live.lons),
              Float64Array.from(live.lats), nYears, customPolygon)
            perSeason[season] = {
              years: s.years,
              values: Array.from(rs.values).map((v) => (Number.isFinite(v) ? v : null)),
              nCells: rs.nCells,
            }
          }
        } else {
          // preset (MERRA-2) or mission/model/station series, same lookup as the workspace
          const [presets, missions] = await Promise.all([loadPresets(), loadMissions()])
          const key = (variable as VariableMeta & { has_global_map?: boolean }).has_global_map === false
            ? variable.id : variable.power_parameter
          for (const season of Object.keys(cat.seasons)) {
            const e = await getSeriesEntry(key, season, regionId, presets, missions)
            perSeason[season] = e ? { years: e.years, values: e.values, nCells: e.n_cells } : null
          }
        }
        if (!cancelled) setSources(perSeason)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    const id = setTimeout(run, 30)
    return () => { cancelled = true; clearTimeout(id) }
  }, [cat, variable, regionId, customPolygon])

  // standard windows x seasons table (only computed when that view is open)
  const table = useMemo(() => {
    if (view !== 'seasons' || !sources) return null
    const out: Record<string, { n: number; label: string } & Partial<Summarized>> = {}
    for (const [season, src] of Object.entries(sources)) {
      if (!src) continue
      for (const w of cat.windows) {
        const a = regionAnalysis(src.years, src.values, src.nCells,
          { start: w.start, end: w.end }, cfg)
        out[`${w.id}|${season}`] = a.summary as never
      }
    }
    return out
  }, [view, sources, cat, cfg])

  if (!region && regionId !== 'custom') return <p className="muted">No region selected.</p>

  const regionName = regionId === 'custom' ? 'your custom region' : region?.name
  const seasonSource = sources?.[store.season] ?? null
  const winMeta = cat.windows.find((w) => w.id === store.windowId)

  const mv = variable as MissionVariable
  const sourceText = regionId === 'custom' ? 'NASA POWER · live fetch'
    : mv.instrument ? mv.instrument : 'NASA POWER · MERRA-2 reanalysis'
  const winText = (w: { id: string; start: number; end: number }) =>
    w.id === 'full' ? `${w.start}–${w.end}` : w.id === 'w30' ? '30 years' : '20 years'

  return (
    <div className="xpanel flush">
      <div className="xpanel-head">
        <div className="seg no-print" role="group" aria-label="Sensitivity view">
          <button aria-pressed={view === 'windows'} onClick={() => setView('windows')}>
            Start × end year windows
          </button>
          <button aria-pressed={view === 'seasons'} onClick={() => setView('seasons')}>
            Seasons × standard windows
          </button>
        </div>
        <div className="xpanel-sources">
          <span className="source"><Icon name={mv.source_type === 'mission' ? 'sat' : 'rings'} />{sourceText}</span>
        </div>
      </div>

      <p className="muted small sens-intro">
        Sensitivity to analysis choices for <b>{variable.short_name}</b> in{' '}
        <b>{regionName}</b>
        {view === 'windows'
          ? <> ({cat.seasons[store.season].label}): the same test run on every window of {cfg.minYears}+ years. A
            story that holds across nearly all of them is robust; one that appears only for particular dates
            deserves scepticism.</>
          : <>: every standard window × season combination. Click a cell to load it into the workspace.</>}
        {regionId === 'custom' && ' (Custom regions use your live NASA fetch.)'}
      </p>
      {busy && <div className="loading"><div className="spinner" /> Loading series…</div>}
      {error && <div className="cautionbox">Live fetch failed: {error}</div>}

      {view === 'windows' && sources && (
        seasonSource
          ? <WindowHeatmap years={seasonSource.years} values={seasonSource.values} cfg={cfg}
              trendUnits={variable.trend_units}
              selected={winMeta ? { start: winMeta.start, end: winMeta.end } : undefined} />
          : <p className="muted small">No series is available for this variable, region and season.</p>
      )}

      {view === 'seasons' && table && (
        <>
          <div className="sens-grid" style={{ gridTemplateColumns: `minmax(52px, .55fr) repeat(${cat.windows.length}, minmax(0, 1fr))` }}>
            <span />
            {cat.windows.map((w) => <span key={w.id} className="sens-colhead">{winText(w)}</span>)}
            {Object.keys(cat.seasons).map((season) => (
              seasonRow(season)
            ))}
          </div>
          <p className="sens-legend">
            <span>Number colour: ember = rising, tide = falling.</span>
            <span>Highlighted cell = the window and season now chosen in the workspace.</span>
          </p>
        </>
      )}
    </div>
  )

  function seasonRow(season: string) {
    return (
      <Fragment key={season}>
        <span className="sens-rowhead">{cat.seasons[season].label.split(' (')[0]}</span>
        {cat.windows.map((w) => {
          const r = table![`${w.id}|${season}`]
          if (!r) return <span key={w.id} />
          const stamp = STAMP[r.label] ?? STAMP['no-detected-trend']
          const dec = r.senSlope !== undefined ? r.senSlope * 10 : NaN
          const on = w.id === store.windowId && season === store.season
          const dir = !Number.isFinite(dec) || Math.abs(dec) < 1e-12 ? '' : dec > 0 ? 'up' : 'down'
          return (
            <button key={w.id} type="button" aria-pressed={on}
              className={`sens-cell ${r.label === 'insufficient-data' ? 'insufficient' : ''}`}
              aria-label={`${cat.seasons[season].label}, ${winText(w)}: ${stamp.text}`}
              onClick={() => { store.setWindow(w.id); store.setSeason(season) }}>
              <span className={`stamp ${stamp.cls}`}>{stamp.text}</span>
              <span className={`sv ${dir}`}>
                {Number.isFinite(dec) ? `${dec >= 0 ? '+' : ''}${dec.toFixed(2)} ${variable.trend_units}` : '—'}
              </span>
              <span className="sl">
                {r.ciLow !== undefined && Number.isFinite(r.ciLow)
                  ? `CI ${(r.ciLow * 10).toFixed(2)} … ${(r.ciHigh! * 10).toFixed(2)}`
                  : `n=${r.n}`}
              </span>
            </button>
          )
        })}
      </Fragment>
    )
  }
}

const STAMP: Record<string, { cls: string; text: string }> = {
  'detected-increase': { cls: 'up', text: 'Increase' },
  'detected-decrease': { cls: 'down', text: 'Decrease' },
  'no-detected-trend': { cls: 'none', text: 'No trend' },
  'insufficient-data': { cls: 'na', text: 'Too short' },
}
