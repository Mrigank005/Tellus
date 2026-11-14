/** Aggregation parity: TS port vs Python-generated fixture.
 * Run from frontend/:  npx tsx ../tests/parity/agg_parity.ts
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregateSeason, type SeasonDef } from '../../frontend/src/engine/aggregate'

const here = dirname(fileURLToPath(import.meta.url))

const SEASON_DEFS: Record<string, SeasonDef> = {
  annual: { label: 'Whole year', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  JJAS: { label: 'Monsoon', months: [6, 7, 8, 9] },
  DJF: { label: 'Winter', months: [12, 1, 2] },
}

interface Fixture {
  n_lat: number
  n_lon: number
  months: number[]
  monthly: (number | null)[]
  cases: Record<string, { years: number[]; values: (number | null)[][] }>
}

const doc: Fixture = JSON.parse(readFileSync(join(here, 'agg_fixture.json'), 'utf8'))
const nCells = doc.n_lat * doc.n_lon
const nMonths = doc.months.length
const monthly = new Float64Array(nMonths * nCells).fill(NaN)
for (let c = 0; c < nCells; c++) {
  const cell = doc.monthly[c] as unknown as (number | null)[]
  for (let m = 0; m < nMonths; m++) {
    const v = cell[m]
    monthly[c * nMonths + m] = v === null ? NaN : v
  }
}

let failures = 0
for (const [key, expected] of Object.entries(doc.cases)) {
  const [season, agg] = key.split('|')
  const got = aggregateSeason(monthly, nCells, doc.months, season, agg as 'mean' | 'sum', SEASON_DEFS)
  if (JSON.stringify(got.years) !== JSON.stringify(expected.years)) {
    console.log(`  YEARS mismatch ${key}: py=${expected.years} ts=${got.years}`)
    failures++
    continue
  }
  let bad = 0
  for (let c = 0; c < nCells; c++)
    for (let k = 0; k < got.years.length; k++) {
      const py = expected.values[c][k]
      const ts = got.values[c * got.years.length + k]
      const pyv = py === null ? NaN : py
      if (Number.isNaN(pyv) !== Number.isNaN(ts) ||
          (Number.isFinite(pyv) && Math.abs(pyv - ts) > 1e-8)) {
        if (bad < 3) console.log(`  ${key} cell ${c} year ${got.years[k]}: py=${py} ts=${ts}`)
        bad++
      }
    }
  if (bad) { console.log(`  VALUES mismatch ${key}: ${bad} cells`); failures++ }
  else console.log(`  ok ${key} (${got.years.length} years x ${nCells} cells)`)
}

if (failures) {
  console.log(`AGG PARITY FAILED (${failures})`)
  process.exit(1)
}
console.log('AGG PARITY OK — TS aggregation matches the Python reference')
