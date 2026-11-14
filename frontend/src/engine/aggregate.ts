/**
 * TypeScript port of pipeline/aggregate.py's monthly -> annual/seasonal rules.
 * Parity is enforced against a Python-generated fixture (tests/parity).
 *
 * Rules mirrored exactly:
 *  - means are day-count-weighted over present months; valid when >=80%
 *    (annual) / 100% (seasons) of months are present
 *  - sums (mm/day rates -> totals) require every month; missing never means 0
 *  - DJF of year N = December of N-1 + January and February of N
 */

export interface SeasonDef {
  label: string
  months: number[]
  convention?: string
}

export function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** Map each output year -> month indices (into `months`) composing it. */
export function seasonYearMap(
  months: number[] | Int32Array, season: string, defs: Record<string, SeasonDef>,
): Map<number, number[]> {
  const arr = months as number[]
  const sm = defs[season].months
  const out = new Map<number, number[]>()
  if (season === 'DJF') {
    const years = new Set(arr.map((m) => Math.floor(m / 100)))
    for (const y of Array.from(years).sort((a, b) => a - b)) {
      const idxDec: number[] = []
      const idxJF: number[] = []
      arr.forEach((m, i) => {
        const yy = Math.floor(m / 100), mm = m % 100
        if (yy === y - 1 && mm === 12) idxDec.push(i)
        if (yy === y && (mm === 1 || mm === 2)) idxJF.push(i)
      })
      if (idxDec.length === 1 && idxJF.length === 2) {
        out.set(y, [...idxJF, ...idxDec])
      }
    }
    return out
  }
  const years = new Set(arr.map((m) => Math.floor(m / 100)))
  for (const y of Array.from(years).sort((a, b) => a - b)) {
    const idx: number[] = []
    arr.forEach((m, i) => {
      const yy = Math.floor(m / 100), mm = m % 100
      if (yy === y && sm.includes(mm)) idx.push(i)
    })
    if (idx.length === sm.length) out.set(y, idx)
  }
  return out
}

export interface SeasonAggregate {
  years: number[]
  values: Float64Array   // [nCells, nYears], NaN for invalid
}

/** monthly: [nCells, nMonths] row-major. */
export function aggregateSeason(
  monthly: Float64Array, nCells: number, months: number[],
  season: string, aggregation: 'mean' | 'sum',
  defs: Record<string, SeasonDef>,
): SeasonAggregate {
  const ym = seasonYearMap(months, season, defs)
  const years = Array.from(ym.keys()).sort((a, b) => a - b)
  const nYears = years.length
  const values = new Float64Array(nCells * nYears).fill(NaN)
  const nMonths = months.length

  for (const [k, y] of years.entries()) {
    const idx = ym.get(y)!
    const nNeeded = idx.length
    for (let c = 0; c < nCells; c++) {
      let num = 0, den = 0, total = 0, nPresent = 0
      for (const mi of idx) {
        const v = monthly[c * nMonths + mi]
        if (Number.isFinite(v)) {
          nPresent++
          const d = daysInMonth(Math.floor(months[mi] / 100), months[mi] % 100)
          if (aggregation === 'mean') {
            num += v * d
            den += d
          } else {
            total += v * d
          }
        }
      }
      let out: number
      if (aggregation === 'mean') {
        const need = Math.ceil((season === 'annual' ? 0.8 : 0.99) * nNeeded)
        out = nPresent >= need && den > 0 ? num / den : NaN
      } else {
        out = nPresent === nNeeded ? total : NaN
      }
      values[c * nYears + k] = out
    }
  }
  return { years, values }
}
