/**
 * Static asset loading for the global Tellus build.
 *
 * Two data surfaces:
 *  - trend packs   one file per variable x season x window: the precomputed
 *                  global map (Int16 slope/CI + Uint8 pFdr/label, gzipped)
 *  - presets.json  precomputed annual series for all preset regions; regional
 *                  verdicts are computed live in the browser from these series
 */
import type { SeasonDef } from './aggregate'

export const NAN_I16 = -32768

export interface VariableMeta {
  id: string
  short_name: string
  long_name: string
  definition: string
  units: string
  monthly_units: string
  aggregation: 'mean' | 'sum'
  trend_units: string
  higher_means: string
  suitable_for: string
  caution?: string
  known_divergence?: string
  caveat?: string
  power_parameter: string
}

export interface RegionMeta {
  id: string
  name: string
  description: string
  polygon: number[][]
}

export interface WindowMeta {
  id: string
  start: number
  end: number
  label: string
  frozen: boolean
}

export interface Catalog {
  generated_at: string
  domain: { name: string; lon_min: number; lon_max: number; lat_min: number; lat_max: number; resolution: number }
  variables: VariableMeta[]
  regions: RegionMeta[]
  seasons: Record<string, SeasonDef>
  windows: WindowMeta[]
  presets_file: string
  trends_index_file: string
  n_cells: number
  gpcp: { regions: string[]; years: number[]; units: string }
  methods?: Methods
}

export interface Methods {
  alpha: number
  confidence_level: number
  min_years: number
  caution_years: number
  fdr_method: string
  fdr_note: string
  test: Record<string, string>
}

export interface Grid {
  lats: Float64Array
  lons: Float64Array
}

export interface TrendPack {
  slope: Float32Array     // per year; x10 for per-decade
  ciLow: Float32Array
  ciHigh: Float32Array
  fdrP: Float32Array      // approx (quantised -log10); NaN when ineligible
  label: Uint8Array       // 0..3 | 0x80 caution bit
  nEligible: number
}

export type Presets = Record<string, Record<string, Record<string, {
  years: number[]
  values: (number | null)[]
  n_cells: number
}>>>

export interface MissionVariable extends VariableMeta {
  instrument: string
  source: string
  source_type: 'mission' | 'model' | 'station'
  has_global_map: boolean
  counters?: string[]
}

export type Missions = Record<string, Presets[string]>

let missionsCache: Missions | null = null
let missionVarsCache: MissionVariable[] | null = null

export async function loadMissions(): Promise<Missions> {
  if (missionsCache) return missionsCache
  try {
    const res = await fetch('./data/missions.json')
    if (!res.ok) return {}
    missionsCache = await res.json() as Missions
  } catch {
    missionsCache = {}
  }
  return missionsCache
}

export async function loadMissionVariables(): Promise<MissionVariable[]> {
  if (missionVarsCache) return missionVarsCache
  const missions = await loadMissions()
  const res = await fetch('./config-missions.json').catch(() => null)
  if (!res || !res.ok) {
    missionVarsCache = []
    return missionVarsCache
  }
  const cfg = await res.json() as { variables: MissionVariable[] }
  missionVarsCache = (cfg.variables ?? []).filter((v) => missions[v.id])
  return missionVarsCache
}

/** Unified regional-series lookup: missions first, then POWER presets. */
export async function getSeriesEntry(
  variableId: string, season: string, regionId: string,
  presets: Presets, missions: Missions | null,
): Promise<{ years: number[]; values: (number | null)[]; n_cells: number } | null> {
  const m = missions?.[variableId]?.[season]?.[regionId]
  if (m) return m
  return presets[variableId]?.[season]?.[regionId] ?? null
}

export interface GpcpData {
  years: number[]
  units: string
  source: string
  regions: Record<string, { values: (number | null)[]; n_cells: number }>
}

let catalogCache: Catalog | null = null
let gridCache: Grid | null = null
let presetsCache: Presets | null = null
export type MonthlyPresets = Record<string, Record<string, { months: number[]; values: (number | null)[] }>>
let monthlyCache: MonthlyPresets | null = null
let gpcpCache: GpcpData | null = null
let trendsIndexCache: Record<string, Record<string, Record<string, { file: string; slope_scale: number; n_eligible: number }>>> | null = null
const packCache = new Map<string, TrendPack>()

export async function loadCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache
  const res = await fetch('./data/catalog.json')
  if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`)
  const cat: Catalog = await res.json()
  if (!cat.methods) {
    const prov = await (await fetch('./data/provenance.json')).json()
    cat.methods = prov.methods
  }
  catalogCache = cat
  return cat
}

export async function loadGrid(): Promise<Grid> {
  if (gridCache) return gridCache
  const res = await fetch('./data/grid.json')
  if (!res.ok) throw new Error(`grid.json: HTTP ${res.status}`)
  const doc = await res.json()
  gridCache = { lats: Float64Array.from(doc.lats), lons: Float64Array.from(doc.lons) }
  return gridCache
}

export async function loadPresets(): Promise<Presets> {
  if (presetsCache) return presetsCache
  const cat = await loadCatalog()
  const res = await fetch(`./data/${cat.presets_file}`)
  if (!res.ok) throw new Error(`presets: HTTP ${res.status}`)
  const p: Presets = await res.json()
  presetsCache = p
  return p
}

export async function loadMonthlyPresets(): Promise<MonthlyPresets> {
  if (monthlyCache) return monthlyCache
  try {
    const res = await fetch('./data/presets_monthly.json')
    if (!res.ok) return {}
    monthlyCache = await res.json() as MonthlyPresets
  } catch {
    monthlyCache = {}
  }
  return monthlyCache
}

export async function loadGpcp(): Promise<GpcpData | null> {
  if (gpcpCache) return gpcpCache
  try {
    const res = await fetch('./data/gpcp_series.json')
    if (!res.ok) return null
    gpcpCache = await res.json()
    return gpcpCache
  } catch {
    return null
  }
}

export async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(data)
  // Some servers serve .gz with Content-Encoding: gzip, in which case fetch has
  // already decompressed the body. Only run DecompressionStream on real gzip.
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!isGzip) return bytes
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the map pack (DecompressionStream missing).')
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function loadTrendPack(
  variableId: string, season: string, windowId: string, nCells: number,
): Promise<TrendPack> {
  const key = `${variableId}_${season}_${windowId}`
  const hit = packCache.get(key)
  if (hit) return hit
  if (!trendsIndexCache) {
    const cat = await loadCatalog()
    const res = await fetch(`./data/${cat.trends_index_file}`)
    if (!res.ok) throw new Error(`trends index: HTTP ${res.status}`)
    const idx = await res.json()
    trendsIndexCache = idx
  }
  const entry = trendsIndexCache?.[variableId]?.[season]?.[windowId]
  if (!entry) throw new Error(`no trend pack for ${key}`)
  const res = await fetch(`./data/trends/${entry.file}`)
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`)
  const raw = await gunzip(await res.arrayBuffer())
  const expected = nCells * 8
  if (raw.length !== expected) throw new Error(`${key}: expected ${expected} bytes, got ${raw.length}`)
  // pack layout: concatenated column blocks — slope[N] ciLow[N] ciHigh[N]
  // (Int16 LE each), then fdrP[N] (Uint8), then label[N] (Uint8)
  const slope = new Float32Array(nCells)
  const ciLow = new Float32Array(nCells)
  const ciHigh = new Float32Array(nCells)
  const fdrP = new Float32Array(nCells).fill(NaN)
  const label = new Uint8Array(nCells)
  const scale = entry.slope_scale
  const slopeI16 = new Int16Array(raw.buffer, raw.byteOffset, nCells)
  const ciLoI16 = new Int16Array(raw.buffer, raw.byteOffset + 2 * nCells, nCells)
  const ciHiI16 = new Int16Array(raw.buffer, raw.byteOffset + 4 * nCells, nCells)
  const pU8 = new Uint8Array(raw.buffer, raw.byteOffset + 6 * nCells, nCells)
  const labelU8 = new Uint8Array(raw.buffer, raw.byteOffset + 7 * nCells, nCells)
  for (let i = 0; i < nCells; i++) {
    const s = slopeI16[i]
    slope[i] = s === NAN_I16 ? NaN : s * scale
    const lo = ciLoI16[i]
    ciLow[i] = lo === NAN_I16 ? NaN : lo * scale
    const hi = ciHiI16[i]
    ciHigh[i] = hi === NAN_I16 ? NaN : hi * scale
    const p = pU8[i]
    if (p !== 255) fdrP[i] = Math.pow(10, -p / 20)
    label[i] = labelU8[i]
  }
  const pack: TrendPack = { slope, ciLow, ciHigh, fdrP, label, nEligible: entry.n_eligible }
  packCache.set(key, pack)
  return pack
}
