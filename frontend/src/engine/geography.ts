/**
 * Geography helpers mirroring pipeline/aggregate.py:
 * cell-in-polygon by ray casting on cell centres, cos(latitude) area weights.
 */
import type { Summarized } from './stats'
import { summarize } from './stats'

export type Polygon = number[][] // [[lon, lat], ...]

export function pointInPolygon(lon: number, lat: number, polygon: Polygon): boolean {
  const n = polygon.length
  let inside = false
  let j = n - 1
  for (let i = 0; i < n; i++) {
    const xi = polygon[i][0], yi = polygon[i][1]
    const xj = polygon[j][0], yj = polygon[j][1]
    if (yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
    j = i
  }
  return inside
}

export function regionMask(
  lons: Float64Array, lats: Float64Array, polygon: Polygon,
): Uint8Array {
  const mask = new Uint8Array(lats.length * lons.length)
  for (let i = 0; i < lats.length; i++)
    for (let j = 0; j < lons.length; j++)
      if (pointInPolygon(lons[j], lats[i], polygon)) mask[i * lons.length + j] = 1
  return mask
}

export interface RegionSeries {
  values: Float64Array       // [nYears], NaN where nothing valid
  nCells: number
  nValid: number[]           // per year
}

/** cos(latitude)-weighted mean series over cells whose centre is in polygon. */
export function regionSeries(
  series: Float32Array,      // [nLat*nLon, nYears]
  lons: Float64Array,
  lats: Float64Array,
  nYears: number,
  polygon: Polygon,
): RegionSeries {
  const nl = lons.length
  const mask = regionMask(lons, lats, polygon)
  const values = new Float64Array(nYears).fill(NaN)
  const nValid = new Array<number>(nYears).fill(0)
  let nCells = 0
  const num = new Float64Array(nYears)
  const den = new Float64Array(nYears)
  for (let i = 0; i < lats.length; i++) {
    const w = Math.cos((lats[i] * Math.PI) / 180)
    for (let j = 0; j < nl; j++) {
      if (!mask[i * nl + j]) continue
      nCells++
      const row = i * nl + j
      for (let k = 0; k < nYears; k++) {
        const v = series[row * nYears + k]
        if (Number.isFinite(v)) {
          num[k] += w * v
          den[k] += w
          nValid[k]++
        }
      }
    }
  }
  for (let k = 0; k < nYears; k++)
    if (den[k] > 0) values[k] = num[k] / den[k]
  return { values, nCells, nValid }
}

/** Area fraction in each category; area weight ~ cos(latitude). */
export function areaFractionsByCategory(
  labels: Uint8Array,          // [nLat*nLon] label codes 0..3 in the low bits; 0x40 naive-only and 0x80 caution are flags
  lats: Float64Array,
  lons: Float64Array,
  mask?: Uint8Array,
): Record<string, number> {
  const cats = ['detected-increase', 'detected-decrease', 'no-detected-trend', 'insufficient-data']
  const sums = new Float64Array(4)
  let total = 0
  const nl = lons.length
  for (let i = 0; i < lats.length; i++) {
    const w = Math.cos((lats[i] * Math.PI) / 180)
    for (let j = 0; j < nl; j++) {
      const idx = i * nl + j
      if (mask && !mask[idx]) continue
      total += w
      const code = labels[idx] & 0x3f
      if (code < 4) sums[code] += w
    }
  }
  const out: Record<string, number> = {}
  for (let c = 0; c < 4; c++) out[cats[c]] = total > 0 ? sums[c] / total : 0
  return out
}

/** Region trend summary from a prepared (year-filtered) series. */
export function regionTrend(
  years: number[], values: number[] | Float64Array,
  alpha: number, minYears: number, cautionYears: number,
): Summarized | { n: number; label: string } {
  return summarize(years, values as number[], alpha, minYears, cautionYears)
}
