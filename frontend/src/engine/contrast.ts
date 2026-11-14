/**
 * S8 — opposite-trends finder. The challenge's opening sentence, one button:
 * "a measured variable can trend one way in one region and the opposite way
 * in another". Finds the preset-region pair with the strongest detected
 * trends of OPPOSITE sign for the chosen variable, ranked by the weaker of
 * the two |z| statistics (both sides must be individually significant).
 */
import type { Presets } from './loader'
import { summarize } from './stats'

export interface ContrastPair {
  a: string
  b: string
  slopeA: number   // per decade
  slopeB: number
  zA: number
  zB: number
  score: number    // weaker |z| of the two
}

export function findOppositeTrends(
  presets: Presets, param: string, season: string,
  windowStart: number, windowEnd: number,
  alpha = 0.05, minYears = 20, cautionYears = 25,
  limit = 3,
): ContrastPair[] {
  const results: ContrastPair[] = []
  const regions = Object.keys(presets[param]?.[season] ?? {})
  interface Row { label: string; senSlope: number; mkZAdj: number }
  const summaries = new Map<string, Row>()

  for (const rid of regions) {
    const e = presets[param][season][rid]
    const years: number[] = []
    const values: number[] = []
    e.years.forEach((y, i) => {
      if (y >= windowStart && y <= windowEnd && e.values[i] !== null) {
        years.push(y)
        values.push(e.values[i] as number)
      }
    })
    const s = summarize(years, values, alpha, minYears, cautionYears) as never as
      { label: string; senSlope: number; mkZAdj: number }
    summaries.set(rid, s)
  }

  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j]
      const sa = summaries.get(a)!, sb = summaries.get(b)!
      if (sa.label !== 'detected-increase' && sa.label !== 'detected-decrease') continue
      if (sb.label !== 'detected-increase' && sb.label !== 'detected-decrease') continue
      if (Math.sign(sa.senSlope) === Math.sign(sb.senSlope)) continue
      const score = Math.min(Math.abs(sa.mkZAdj), Math.abs(sb.mkZAdj))
      results.push({
        a, b,
        slopeA: sa.senSlope * 10, slopeB: sb.senSlope * 10,
        zA: sa.mkZAdj, zB: sb.mkZAdj, score,
      })
    }
  }
  results.sort((x, y) => y.score - x.score)
  return results.slice(0, limit)
}
