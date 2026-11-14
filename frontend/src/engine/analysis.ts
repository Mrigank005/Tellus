/**
 * Analysis orchestration. Global maps are precomputed packs (see loader.ts);
 * regional analyses run live in the browser on preset series or on custom
 * regions fetched directly from NASA POWER (powerLive.ts).
 */
import type { Grid } from './loader'
import { areaFractionsByCategory } from './geography'
import { summarize, type Summarized } from './stats'

export interface RegionAnalysis {
  years: number[]
  series: { values: Float64Array | number[]; nCells: number; nValid: number[] }
  window: { start: number; end: number }
  summary: Summarized | { n: number; label: string }
  coverage: number
}

export const LABEL_NAMES = ['detected-increase', 'detected-decrease',
  'no-detected-trend', 'insufficient-data'] as const

export interface AnalysisConfig {
  alpha: number
  minYears: number
  cautionYears: number
  conf: number
  fdrMethod: 'bh' | 'by'
}

/** Build a RegionAnalysis from a precomputed regional series. */
export function regionAnalysis(
  allYears: number[], allValues: (number | null)[] | Float64Array, nCells: number,
  window: { start: number; end: number }, cfg: AnalysisConfig,
): RegionAnalysis {
  const years: number[] = []
  const values: number[] = []
  allYears.forEach((y, i) => {
    if (y >= window.start && y <= window.end) {
      const raw = allValues[i]
      years.push(y)
      values.push(raw === null || raw === undefined ? NaN : Number(raw))
    }
  })
  const perYearValid: number[] = values.map((v) => (Number.isFinite(v) ? 1 : 0))
  const coverage = values.length
    ? perYearValid.reduce((a: number, b: number) => a + b, 0) / values.length
    : 0
  const summary = summarize(years, values, cfg.alpha, cfg.minYears, cfg.cautionYears)
  return {
    years, series: { values, nCells, nValid: perYearValid },
    window, summary, coverage,
  }
}

export function areaSummary(
  labels: Uint8Array, grid: Grid,
): Record<string, number> {
  return areaFractionsByCategory(labels, grid.lats, grid.lons)
}
