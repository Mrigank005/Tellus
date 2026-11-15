/**
 * Shared verdict for the journey (Read, Real). It follows the zustand selection
 * and runs exactly the same engine calls as the field desk (WorkspaceScreen):
 * getSeriesEntry -> regionAnalysis -> summarize (persistence-adjusted), then
 * timeOfEmergence and pettitt on the same series, so the two screens always agree.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../state/store'
import {
  getSeriesEntry, loadCatalog, loadMissionVariables, loadMissions, loadPresets,
  type Catalog, type MissionVariable, type Missions, type Presets, type RegionMeta,
  type VariableMeta, type WindowMeta,
} from '../../engine/loader'
import { regionAnalysis, type AnalysisConfig } from '../../engine/analysis'
import {
  LABELS, medianSorted, pettitt, timeOfEmergence,
  type Emergence, type PettittResult, type Summarized,
} from '../../engine/stats'
import { detectionHorizon, residualSd, type DetectionHorizon } from '../../engine/detect'
import { lowerMeans } from '../../engine/explain'
import { changePointVisible } from '../../engine/narrative'
import { place } from '../../state/places'

/* ------------------------------------------------------------------ data */

interface Loaded { cat: Catalog; presets: Presets; missions: Missions; missionVars: MissionVariable[] }
let loadedP: Promise<Loaded> | null = null

export function loadJourneyData(): Promise<Loaded> {
  if (!loadedP) {
    loadedP = Promise.all([loadCatalog(), loadPresets(), loadMissions(), loadMissionVariables()])
      .then(([cat, presets, missions, missionVars]) => ({ cat, presets, missions, missionVars }))
      .catch((e) => { loadedP = null; throw e })
  }
  return loadedP
}

type VarX = VariableMeta & {
  min_years?: number; has_global_map?: boolean; source?: string; instrument?: string; source_type?: string
}

/* ------------------------------------------------------------- the model */

export type VerdictStatus = 'ready' | 'nodata' | 'custom'

export interface SourceBadge { label: string; url: string; title: string }

export interface JourneyVerdict {
  status: VerdictStatus
  /** why there is no series (nodata) */
  message: string | null
  variable: VarX | null
  region: RegionMeta | null
  windowMeta: WindowMeta | null
  cfg: AnalysisConfig | null
  noun: string
  place: { title: string; mid: string; is: string }
  seasonText: string
  /** finite years / values only, in order */
  years: number[]
  values: number[]
  span: string
  label: string
  summary: Summarized | null
  /** years valid in the window (summary.n also works when summary exists) */
  nValid: number
  unitsShort: string
  trendUnits: string
  decimals: number
  slopeDec: number
  ciLowDec: number
  ciHighDec: number
  intercept: number
  em: Emergence | null
  pt: PettittResult | null
  cpVisible: boolean
  horizon: DetectionHorizon | null
  source: SourceBadge
  /** the selection key this verdict belongs to */
  key: string
}

const NASA_POWER: SourceBadge = {
  label: 'NASA POWER · MERRA-2', url: 'https://power.larc.nasa.gov/',
  title: 'NASA POWER, MERRA-2 reanalysis',
}

/* ----------------------------------------------------------------- words */

const NOUNS: Record<string, string> = {
  T2M: 'air temperature', T2M_MAX: 'daytime maximum temperature',
  T2M_MIN: 'nighttime minimum temperature', PRECTOTCORR: 'rainfall',
  RH2M: 'relative humidity', WS10M: 'wind speed', GWETTOP: 'surface soil wetness',
  EVLAND: 'evaporation over land',
}

export function nounFor(v: VariableMeta | null): string {
  if (!v) return 'this measure'
  if (NOUNS[v.id]) return NOUNS[v.id]
  const s = v.short_name.replace(/\s*\([^)]*\)\s*$/, '')
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

export const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** "The Arctic" at the start of a sentence, "the Arctic" in the middle of one. */
export function placeName(region: RegionMeta | null, regionId: string): { title: string; mid: string; is: string } {
  if (regionId !== 'custom' && !region) return { title: 'This region', mid: 'this region', is: 'is' }
  const p = place(regionId, region?.name)
  return { title: p.title, mid: p.mid, is: p.is }
}

/** "{place} is ___": phrase for an increase and a decrease of this variable. */
const DIR: Record<string, [string, string]> = {
  warmer: ['getting warmer', 'getting cooler'],
  'warmer nights': ['seeing warmer nights', 'seeing cooler nights'],
  'warmer ocean': ['getting warmer', 'getting cooler'],
  'hotter daytime extremes': ['seeing hotter daytime highs', 'seeing cooler daytime highs'],
  wetter: ['getting wetter', 'getting drier'],
  'wetter soils': ['seeing wetter soils', 'seeing drier soils'],
  'more humid': ['getting more humid', 'getting less humid'],
  windier: ['getting windier', 'getting calmer'],
  greener: ['getting greener', 'getting less green'],
  'hazier air': ['seeing hazier air', 'seeing clearer air'],
  'more polluted air': ['seeing more polluted air', 'seeing cleaner air'],
  'more phytoplankton': ['seeing more phytoplankton', 'seeing less phytoplankton'],
  'more evaporative demand': ['seeing more evaporative demand', 'seeing less evaporative demand'],
  'more water leaving the land': ['seeing more water leave the land', 'seeing less water leave the land'],
  'more water returning to the air': ['seeing more water return to the air', 'seeing less water return to the air'],
}

export function directionPhrase(v: VariableMeta | null, up: boolean): string {
  const hm = v?.higher_means ?? 'higher'
  const hit = DIR[hm]
  if (hit) return up ? hit[0] : hit[1]
  return `trending toward ${up ? hm : lowerMeans(hm)}`
}

export function seasonLabel(cat: Catalog | null, season: string): string {
  if (season === 'annual') return 'whole year'
  const l = cat?.seasons[season]?.label
  return l ? l.split(' (')[0] : season
}

/* ---- numbers ---- */

export function decimalsFor(x: number): number {
  const a = Math.abs(x)
  if (!Number.isFinite(a) || a === 0) return 2
  if (a >= 100) return 0
  if (a >= 10) return 1
  if (a >= 0.1) return 2
  if (a >= 0.01) return 3
  return 4
}

export function fmtSigned(x: number, d: number): string {
  if (!Number.isFinite(x)) return '–'
  const t = Math.abs(x).toFixed(d)
  if (Number(t) === 0) return t
  return `${x < 0 ? '−' : '+'}${t}`
}

export function fmtPlain(x: number, d: number): string {
  if (!Number.isFinite(x)) return '–'
  return `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`
}

/** p-value for display ("< 0.001", "0.034"). */
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '–'
  if (p < 0.001) return '< 0.001'
  return p < 0.1 ? p.toFixed(3) : p.toFixed(2)
}

/** The page title of the Read section: the answer as a sentence. */
export function verdictTitle(v: JourneyVerdict | null): string {
  if (!v) return 'Reading the record…'
  if (v.status === 'custom') return 'Your drawn region is read in the field desk.'
  if (v.status === 'nodata') return `Tellus has no ${v.noun} record for ${v.place.mid}.`
  if (v.label === LABELS.insufficientData || !v.summary) return `Too little data to say anything about ${v.noun} for ${v.place.mid}.`
  if (v.label === LABELS.noDetectedTrend) return `No clear change in ${v.noun} over ${v.place.mid}.`
  const up = v.label === LABELS.detectedIncrease
  const head = `${v.place.title} ${v.place.is} ${directionPhrase(v.variable, up)}`
  const em = v.em
  if (em?.status === 'emerged' && em.emergenceYear !== null) {
    return em.yearsBeforeEnd === 0
      ? `${head}, and that has only just become clear.`
      : `${head}, and it has been clear since ${em.emergenceYear}.`
  }
  return `${head}.`
}

/* ---------------------------------------------------------------- build */

interface Sel { variableId: string; season: string; windowId: string; regionId: string }
export const selKey = (s: Sel) => `${s.variableId}|${s.season}|${s.windowId}|${s.regionId}`

/** The data-source badge for a variable: label, link and full name. */
export function sourceFor(v: VarX): SourceBadge {
  if (v.has_global_map !== false) return NASA_POWER
  const src = v.source ?? ''
  const label = (v.instrument ?? v.short_name).split(' (')[0]
  let url = 'https://www.earthdata.nasa.gov/'
  if (/^Giovanni/i.test(src)) url = 'https://giovanni.gsfc.nasa.gov/giovanni/'
  else if (/KNMI/i.test(src)) url = 'https://climexp.knmi.nl/'
  else if (/NCEI/i.test(src)) url = 'https://www.ncei.noaa.gov/products/land-based-station/global-summary-of-the-month'
  return { label, url, title: src || label }
}

function emptyVerdict(over: Partial<JourneyVerdict> & { key: string }): JourneyVerdict {
  return {
    status: 'nodata', message: null, variable: null, region: null, windowMeta: null, cfg: null,
    noun: 'this measure', place: { title: 'This region', mid: 'this region', is: 'is' }, seasonText: '',
    years: [], values: [], span: '', label: LABELS.insufficientData, summary: null, nValid: 0,
    unitsShort: '', trendUnits: '', decimals: 2, slopeDec: NaN, ciLowDec: NaN, ciHighDec: NaN, intercept: NaN,
    em: null, pt: null, cpVisible: false, horizon: null, source: NASA_POWER,
    ...over,
  }
}

const cache = new Map<string, Promise<JourneyVerdict>>()

async function build(sel: Sel, customPolygon: unknown, data: Loaded): Promise<JourneyVerdict> {
  const { cat, presets, missions, missionVars } = data
  const key = selKey(sel)
  const allVars: VarX[] = [...cat.variables, ...missionVars] as VarX[]
  const variable = allVars.find((v) => v.id === sel.variableId) ?? null
  const windowMeta = cat.windows.find((w) => w.id === sel.windowId) ?? null
  const region = cat.regions.find((r) => r.id === sel.regionId) ?? null
  const place = placeName(region, sel.regionId)
  const noun = nounFor(variable)
  const seasonText = seasonLabel(cat, sel.season)
  const base = { key, variable, region, windowMeta, noun, place, seasonText }

  if (!variable || !windowMeta || !cat.methods) {
    return emptyVerdict({ ...base, message: 'Tellus could not find that question in its catalog.' })
  }
  const m = cat.methods
  const minYears = variable.min_years ?? m.min_years
  const cfg: AnalysisConfig = {
    alpha: m.alpha, minYears, cautionYears: Math.max(minYears, m.caution_years),
    conf: m.confidence_level, fdrMethod: 'bh',
  }
  const source = sourceFor(variable)
  const unitsShort = variable.trend_units.replace(' per decade', '')

  if (sel.regionId === 'custom') {
    return emptyVerdict({
      ...base, status: 'custom', cfg, source, unitsShort, trendUnits: variable.trend_units,
      message: customPolygon
        ? 'A region you draw is fetched live from NASA POWER in the field desk, so it is read there.'
        : 'Pick a place above, or draw your own region in the field desk.',
    })
  }

  const isMission = variable.has_global_map === false
  const seriesKey = isMission ? variable.id : variable.power_parameter
  const entry = await getSeriesEntry(seriesKey, sel.season, sel.regionId, presets, missions)
  if (!entry) {
    const covered = isMission
      ? cat.regions.filter((r) => missions?.[variable.id]?.[sel.season]?.[r.id]).map((r) => placeName(r, r.id).mid)
      : []
    const message = `${variable.short_name} has no record for ${place.mid}`
      + (sel.season !== 'annual' ? ' in this season' : '') + '. '
      + (covered.length ? `This dataset covers: ${covered.join(', ')}.` : 'Try another region or season.')
    return emptyVerdict({ ...base, cfg, source, unitsShort, trendUnits: variable.trend_units, message })
  }

  const win = { start: windowMeta.start, end: windowMeta.end }
  const analysis = regionAnalysis(entry.years, entry.values, entry.n_cells, win, cfg)
  const rawVals = Array.from(analysis.series.values)
  const years: number[] = [], values: number[] = []
  analysis.years.forEach((y, i) => { if (Number.isFinite(rawVals[i])) { years.push(y); values.push(rawVals[i]) } })
  const span = years.length ? (years[0] === years[years.length - 1] ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}`) : ''

  const s = analysis.summary
  // below the minimum record the desk shows no numbers; neither do we
  const full = 'senSlope' in s && s.label !== LABELS.insufficientData ? (s as Summarized) : null
  let em: Emergence | null = null
  let pt: PettittResult | null = null
  let horizon: DetectionHorizon | null = null
  let intercept = NaN
  let slopeDec = NaN, ciLowDec = NaN, ciHighDec = NaN
  if (full) {
    em = timeOfEmergence(analysis.years, rawVals, cfg.minYears, cfg.alpha, cfg.cautionYears)
    pt = pettitt(analysis.years, rawVals)
    slopeDec = full.senSlope * 10
    ciLowDec = full.ciAdjLow * 10
    ciHighDec = full.ciAdjHigh * 10
    const resid = values.map((val, i) => val - full.senSlope * years[i]).sort((a, b) => a - b)
    intercept = medianSorted(resid)
    if (full.label === LABELS.noDetectedTrend) {
      horizon = detectionHorizon(full.n, full.senSlope, residualSd(values), full.lag1R)
    }
  }
  return {
    ...emptyVerdict({ ...base }),
    status: 'ready', message: null, cfg, source, years, values, span,
    label: s.label, summary: full, nValid: s.n,
    unitsShort, trendUnits: variable.trend_units,
    decimals: decimalsFor(slopeDec),
    slopeDec, ciLowDec, ciHighDec, intercept, em, pt, cpVisible: changePointVisible(pt),
    horizon,
  }
}

/** One computation per selection, shared by every section that asks for it. */
export function verdictFor(sel: Sel, customPolygon: unknown, data: Loaded): Promise<JourneyVerdict> {
  const k = selKey(sel) + (sel.regionId === 'custom' ? (customPolygon ? '|poly' : '|none') : '')
  let p = cache.get(k)
  if (!p) {
    p = build(sel, customPolygon, data)
    p.catch(() => cache.delete(k))
    cache.set(k, p)
    if (cache.size > 40) cache.delete(cache.keys().next().value as string)
  }
  return p
}

export interface JourneyVerdictState {
  /** null until the first result (or an error) arrives */
  v: JourneyVerdict | null
  /** a newer selection is being computed; v is the previous one */
  pending: boolean
  error: string | null
}

export function useJourneyVerdict(): JourneyVerdictState {
  const variableId = useStore((s) => s.variableId)
  const season = useStore((s) => s.season)
  const windowId = useStore((s) => s.windowId)
  const regionId = useStore((s) => s.regionId)
  const customPolygon = useStore((s) => s.customPolygon)
  const [res, setRes] = useState<JourneyVerdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = selKey({ variableId, season, windowId, regionId })

  useEffect(() => {
    let cancelled = false
    loadJourneyData()
      .then((data) => verdictFor({ variableId, season, windowId, regionId }, customPolygon, data))
      .then((v) => { if (!cancelled) { setRes(v); setError(null) } })
      .catch((e) => { if (!cancelled) setError((e as Error).message || 'Could not load the data.') })
    return () => { cancelled = true }
  }, [variableId, season, windowId, regionId, customPolygon])

  return { v: res, pending: !res || res.key !== key, error }
}
