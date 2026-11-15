/**
 * Live NASA POWER access for custom regions.
 *
 * When a user draws their own region, Tellus fetches MERRA-2 monthly data
 * for that bounding box DIRECTLY from the NASA POWER API in the browser
 * (CORS-enabled, no key), then aggregates and analyses it locally with the
 * same parity-tested engine used everywhere else. Requires internet; preset
 * regions work fully offline.
 *
 * POWER regional constraints (verified empirically): at least 2° span in
 * latitude and longitude, at most 10° in each, one parameter per request.
 */
import { aggregateSeason, type SeasonDef } from './aggregate'

export const POWER_BASE = 'https://power.larc.nasa.gov/api/temporal/monthly/regional'
const START_YEAR = 1981
const END_YEAR = 2025
const MAX_TILES = 36 // hard politeness/safety cap (~3,600 cells)
const EXPECTED_MONTHS = Array.from(
  { length: (END_YEAR - START_YEAR + 1) * 12 },
  (_, k) => {
    const y = START_YEAR + Math.floor(k / 12)
    return y * 100 + (k % 12) + 1
  },
)

export interface BBox {
  lonMin: number
  lonMax: number
  latMin: number
  latMax: number
}

export interface LiveMonthly {
  param: string
  lats: number[]
  lons: number[]
  months: number[]          // EXPECTED_MONTHS
  monthly: Float64Array     // [nCells, nMonths], NaN = missing
  fillValue: number
}

export interface LiveSeason extends LiveMonthly {
  season: string
  years: number[]
  values: Float64Array      // [nCells, nYears]
}

const cache = new Map<string, LiveMonthly>()

export function tileRequests(bbox: BBox, param: string): string[] {
  const latMin = Math.max(-90, bbox.latMin)
  const latMax = Math.min(90, bbox.latMax)
  const lonMin = Math.max(-180, bbox.lonMin)
  const lonMax = Math.min(180, bbox.lonMax)
  // POWER requires >= 2 degrees span; expand tiny boxes around their centre
  const expand = (lo: number, hi: number, min: number, max: number): [number, number] => {
    if (hi - lo >= 2) return [lo, hi]
    const c = (lo + hi) / 2
    return [Math.max(min, c - 1), Math.min(max, c + 1)]
  }
  const [la0, la1] = expand(latMin, latMax, -90, 90)
  const [lo0, lo1] = expand(lonMin, lonMax, -180, 180)
  // POWER accepts at most 10 degrees and at least 2 degrees per request axis.
  // Split each axis into equal tiles of <= 9.9 degrees: exactly-10 tiles were
  // rejected (HTTP 422) after rounding, and a fixed 10-degree step could leave
  // a final sliver narrower than 2 degrees.
  const splits = (lo: number, hi: number): [number, number][] => {
    const n = Math.max(1, Math.ceil((hi - lo) / 9.9))
    const step = (hi - lo) / n
    return Array.from({ length: n }, (_, i) => [lo + i * step, i === n - 1 ? hi : lo + (i + 1) * step])
  }
  const urls: string[] = []
  for (const [lat, lam] of splits(la0, la1)) {
    for (const [lon, lom] of splits(lo0, lo1)) {
      urls.push(
        `${POWER_BASE}?latitude-min=${round6(lat)}&latitude-max=${round6(lam)}` +
        `&longitude-min=${round6(lon)}&longitude-max=${round6(lom)}` +
        `&parameters=${param}&community=AG&start=${START_YEAR}&end=${END_YEAR}&format=JSON`,
      )
    }
  }
  return urls
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

async function fetchJson(url: string, attempt = 0): Promise<any> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    if (attempt >= 2) throw e
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
    return fetchJson(url, attempt + 1)
  }
}

export function bboxKey(param: string, b: BBox): string {
  return `${param}:${round6(b.lonMin)},${round6(b.latMin)},${round6(b.lonMax)},${round6(b.latMax)}`
}

/** Fetch a bbox's monthly record from NASA POWER (cached per bbox+param). */
export async function fetchLiveMonthly(
  param: string,
  bbox: BBox,
  onProgress?: (done: number, total: number) => void,
): Promise<LiveMonthly> {
  const key = bboxKey(param, bbox)
  const hit = cache.get(key)
  if (hit) return hit

  const urls = tileRequests(bbox, param)
  if (urls.length > MAX_TILES) {
    throw new Error(
      `That box needs ${urls.length} NASA requests (max ${MAX_TILES}). Draw a smaller area — up to about 30°×30° — or pick a preset region.`,
    )
  }

  const cells = new Map<string, { lat: number; lon: number; vals: Float64Array }>()
  const nMonths = EXPECTED_MONTHS.length
  let done = 0
  const CONCURRENCY = 4
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY)
    const docs = await Promise.all(batch.map((u) => fetchJson(u)))
    for (const doc of docs) {
      if (!doc?.features) throw new Error('POWER returned no features')
      for (const feat of doc.features) {
        const lon = round6(feat.geometry.coordinates[0])
        const lat = round6(feat.geometry.coordinates[1])
        const k = `${lat}|${lon}`
        let cell = cells.get(k)
        if (!cell) {
          cell = { lat, lon, vals: new Float64Array(nMonths).fill(NaN) }
          cells.set(k, cell)
        }
        const series = feat.properties.parameter[param]
        for (const [mk, mv] of Object.entries(series)) {
          const m = parseInt(mk, 10)
          if (m % 100 === 13) continue
          const idx = (Math.floor(m / 100) - START_YEAR) * 12 + (m % 100) - 1
          const v = typeof mv === 'number' ? mv : parseFloat(String(mv))
          if (idx >= 0 && idx < nMonths && v > -900) cell.vals[idx] = v
        }
      }
    }
    done += batch.length
    onProgress?.(done, urls.length)
  }

  const lats = Array.from(cells.values()).map((c) => c.lat).sort((a, b) => a - b)
  const lons = Array.from(cells.values()).map((c) => c.lon).sort((a, b) => a - b)
  const latIdx = new Map(lats.map((v, i) => [v, i]))
  const lonIdx = new Map(lons.map((v, i) => [v, i]))
  const nLat = lats.length, nLon = lons.length
  const monthly = new Float64Array(nLat * nLon * nMonths).fill(NaN)
  let fillValue = -999
  for (const c of cells.values()) {
    const i = latIdx.get(c.lat)!, j = lonIdx.get(c.lon)!
    monthly.set(c.vals, (i * nLon + j) * nMonths)
  }
  const live: LiveMonthly = { param, lats, lons, months: EXPECTED_MONTHS, monthly, fillValue }
  cache.set(key, live)
  return live
}

/** Aggregate a live fetch into a season (same rules as the static pipeline). */
export function liveSeason(
  live: LiveMonthly, season: string, aggregation: 'mean' | 'sum',
  defs: Record<string, SeasonDef>,
): { years: number[]; values: Float64Array; nCells: number; nLat: number; nLon: number } {
  const nCells = live.lats.length * live.lons.length
  const agg = aggregateSeason(live.monthly, nCells, live.months, season, aggregation, defs)
  return { ...agg, nCells, nLat: live.lats.length, nLon: live.lons.length }
}

/** Cached live fetch, if this bbox was already fetched. */
export function peekLive(param: string, bbox: BBox): LiveMonthly | undefined {
  return cache.get(bboxKey(param, bbox))
}
