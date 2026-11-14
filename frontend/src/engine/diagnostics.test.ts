import { describe, expect, it } from 'vitest'
import {
  pettitt, slopeDifference, timeOfEmergence, windowRobustness, windowScan,
} from './stats'
import { regionRelation } from './regionOverlap'
import { emergenceSentence, robustnessSentence } from './narrative'

// small deterministic PRNG (mulberry32) + Box-Muller
function rng(seed: number) {
  let a = seed
  const u = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u())
}
const YEARS = Array.from({ length: 45 }, (_, i) => 1981 + i)
const series = (f: (yr: number, e: number) => number, seed: number, sd = 1) => {
  const g = rng(seed)
  return YEARS.map((yr) => f(yr, g() * sd))
}

describe('timeOfEmergence', () => {
  it('known slope emerges and stays', () => {
    const y = series((yr, e) => 0.08 * (yr - 1981) + e, 3, 0.4)
    const e = timeOfEmergence(YEARS, y)
    expect(e.status).toBe('emerged')
    expect(e.direction).toBe(1)
    expect(e.emergenceYear!).toBeGreaterThanOrEqual(2000)
    expect(e.yearsBeforeEnd).toBe(2025 - e.emergenceYear!)
    expect(emergenceSentence(e, 20, 1981)).toContain('statistically clear')
  })
  it('noise rarely emerges', () => {
    let hits = 0
    for (let s = 0; s < 100; s++)
      if (timeOfEmergence(YEARS, series((_, e) => e, 900 + s)).status === 'emerged') hits++
    expect(hits).toBeLessThan(15)
  })
  it('a reversing trend does not count as emerged', () => {
    const y = series((yr, e) => (yr <= 2000 ? 0.15 * (yr - 1981) : 0.15 * 19 - 0.45 * (yr - 2000)) + e, 7, 0.3)
    const e = timeOfEmergence(YEARS, y)
    expect(e.everDetected).toBe(true)
    expect(e.status).toBe('not-emerged')
    expect(emergenceSentence(e, 20, 1981)).toContain('not yet emerged')
  })
})

describe('slopeDifference', () => {
  it('very different slopes differ', () => {
    const a = series((yr, e) => 0.08 * (yr - 1981) + e, 1, 0.5)
    const b = series((yr, e) => -0.03 * (yr - 1981) + e, 2, 0.5)
    const d = slopeDifference(YEARS, a, YEARS, b)
    expect(d.label).toBe('differ')
    expect(d.ciLow!).toBeGreaterThan(0)
  })
  it('equal slopes are mostly not different', () => {
    let diff = 0
    for (let s = 0; s < 100; s++) {
      const a = series((yr, e) => 0.03 * (yr - 1981) + e, 100 + s, 0.5)
      const b = series((yr, e) => 0.03 * (yr - 1981) + e, 500 + s, 0.5)
      if (slopeDifference(YEARS, a, YEARS, b).label === 'differ') diff++
    }
    expect(diff).toBeLessThan(15)
  })
  it('uses only shared years', () => {
    const a = series((yr, e) => 0.02 * (yr - 1981) + e, 5, 0.5)
    const d = slopeDifference(YEARS, a, YEARS.slice(30), a.slice(30))
    expect(d.label).toBe('insufficient-data')
    expect(d.n).toBe(15)
  })
})

describe('windowScan', () => {
  it('scans every window of >= minYears and calls a strong trend robust', () => {
    const y = series((yr, e) => 0.08 * (yr - 1981) + e, 21, 0.3)
    const t0 = Date.now()
    const ws = windowScan(YEARS, y)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(ws.windows.length).toBe(351)
    expect(ws.robustness.verdict).toBe('robust-increase')
    expect(robustnessSentence(ws.robustness, 20)).toContain('holds regardless of the dates chosen')
  })
  it('thresholds', () => {
    const inc = 'detected-increase', none = 'no-detected-trend'
    expect(windowRobustness([...Array(8).fill(inc), ...Array(2).fill(none)]).verdict).toBe('robust-increase')
    expect(windowRobustness([...Array(7).fill(inc), ...Array(3).fill(none)]).verdict).toBe('depends')
  })
})

describe('pettitt', () => {
  it('finds a step near its true location', () => {
    const y = series((yr, e) => (yr >= 1998 ? 1.5 : 0) + e, 31, 0.5)
    const r = pettitt(YEARS, y)
    expect(r.pAdj!).toBeLessThan(0.05)
    expect(Math.abs(r.year! - 1998)).toBeLessThanOrEqual(3)
    expect(r.stepBetter).toBe(true)
  })
  it('matches the textbook p formula', () => {
    const y = series((_, e) => e, 4)
    const r = pettitt(YEARS, y)
    const n = 45
    expect(r.p!).toBeCloseTo(Math.min(1, 2 * Math.exp((-6 * r.K! * r.K!) / (n ** 3 + n ** 2))), 12)
    expect(r.pAdj!).toBeGreaterThanOrEqual(r.p!)
  })
})

describe('regionRelation', () => {
  const box = (a: number, b: number, c: number, d: number) => [[a, c], [a, d], [b, d], [b, c]]
  it('flags containment, overlap, and separates touching boxes', () => {
    const earth = box(-180, 180, -90, 90)
    const tropics = box(-180, 180, -23.5, 23.5)
    const amazon = box(-75, -48, -12, 4)
    expect(regionRelation(earth, amazon)).toBe('a-contains-b')
    expect(regionRelation(amazon, tropics)).toBe('b-contains-a')
    expect(regionRelation(box(0, 10, 0, 10), box(5, 15, 5, 15))).toBe('overlap')
    expect(regionRelation(box(0, 10, 0, 10), box(10, 20, 0, 10))).toBe('separate')
    expect(regionRelation(box(0, 10, 0, 10), box(30, 40, 30, 40))).toBe('separate')
  })
})
