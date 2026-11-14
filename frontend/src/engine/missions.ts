/**
 * Region-verdict maps for variables without a per-pixel map (mission series).
 * Colours preset-region polygons by their persistence-adjusted verdict.
 */
import type { Polygon } from './geography'
import { summarize, type Summarized } from './stats'

export interface RegionVerdict {
  regionId: string
  name: string
  polygon: Polygon
  label: string
  slopePerDecade: number
  summary: Summarized | { n: number; label: string }
}

const VERDICT_COLOR: Record<string, string> = {
  'detected-increase': '#e1694b',
  'detected-decrease': '#4f7fd8',
  'no-detected-trend': '#3a465e',
  'insufficient-data': '#20242c',
}

export function verdictColor(label: string): string {
  return VERDICT_COLOR[label] ?? '#3a465e'
}

export function computeRegionVerdicts(
  regions: { id: string; name: string; polygon: number[][] }[],
  seriesByRegion: Record<string, { years: number[]; values: (number | null)[] } | undefined>,
  window: { start: number; end: number },
  cfg: { alpha: number; minYears: number; cautionYears: number },
): RegionVerdict[] {
  const out: RegionVerdict[] = []
  for (const r of regions) {
    const entry = seriesByRegion[r.id]
    if (!entry) {
      out.push({
        regionId: r.id, name: r.name, polygon: r.polygon,
        label: 'insufficient-data', slopePerDecade: NaN,
        summary: { n: 0, label: 'insufficient-data' },
      })
      continue
    }
    const years: number[] = []
    const values: number[] = []
    entry.years.forEach((y, i) => {
      if (y >= window.start && y <= window.end) {
        years.push(y)
        values.push(entry.values[i] === null ? NaN : (entry.values[i] as number))
      }
    })
    const s = summarize(years, values, cfg.alpha, cfg.minYears, cfg.cautionYears)
    const slope = 'senSlope' in s ? s.senSlope * 10 : NaN
    out.push({
      regionId: r.id, name: r.name, polygon: r.polygon,
      label: (s as { label: string }).label, slopePerDecade: slope, summary: s,
    })
  }
  return out
}
