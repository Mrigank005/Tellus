/**
 * Plain-language wording for the four time-series diagnostics (time of
 * emergence, two-region difference, window robustness, change point).
 * Statistics stay available behind "Show the statistics"; these strings are
 * what a student reads first.
 */
import type {
  Emergence, PettittResult, Robustness, SlopeDifference,
} from './stats'
import type { RegionRelation } from './regionOverlap'

const pct = (x: number) => `${Math.round(x * 100)}%`
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—'
  if (p < 0.001) return '< 0.001'
  return p < 0.1 ? p.toFixed(3) : p.toFixed(2)
}

/** "p < 0.001" / "p = 0.03" */
export function pEq(p: number): string {
  const t = fmtP(p)
  return t.startsWith('<') ? `p ${t}` : `p = ${t}`
}

// ---- time of emergence ------------------------------------------------------

export function emergenceSentence(e: Emergence, minYears: number, startYear?: number): string {
  if (e.status === 'insufficient-data') return ''
  const first = startYear ?? (e.firstTestableYear !== null ? e.firstTestableYear - minYears + 1 : "")
  if (e.status === 'not-emerged') {
    const base = `Time of emergence: not yet emerged — the trend has not become statistically clear in the ${first}–${e.lastYear} data.`
    return e.everDetected
      ? `${base} It looked clear for some earlier end years but did not stay clear.`
      : base
  }
  const dir = e.direction >= 0 ? 'increase' : 'decrease'
  const y = e.emergenceYear!
  const n = e.yearsBeforeEnd!
  if (n === 0) {
    return `This ${dir} only became statistically clear with the most recent data (${y}) — a year or two earlier the evidence was not yet strong enough.`
  }
  const yrs = `${n} year${n === 1 ? '' : 's'}`
  if (e.atEarliest) {
    return `This ${dir} was already statistically clear as soon as ${minYears} years of data existed (${y}) and has stayed clear since — ${yrs} before the end of the record (${e.lastYear}).`
  }
  return `This ${dir} became statistically clear in ${y} and has stayed clear since — ${yrs} before the end of the record (${e.lastYear}).`
}

// ---- change point -----------------------------------------------------------

export const CHANGE_POINT_ALPHA = 0.05

/** The Pettitt result is shown only when its persistence-adjusted p < 0.05. */
export function changePointVisible(p: PettittResult | null | undefined): boolean {
  return !!p && p.pAdj !== undefined && p.pAdj < CHANGE_POINT_ALPHA
}

export function changePointLabel(p: PettittResult): string {
  return `possible shift around ${p.year} (Pettitt ${pEq(p.pAdj!)}, exploratory)`
}

export function changePointExplain(p: PettittResult, units: string): string {
  const up = p.meanAfter! > p.meanBefore!
  let s = `Exploratory: the single most likely step in this series falls around ${p.year} (average ${up ? 'up' : 'down'} from ${p.meanBefore!.toFixed(2)} to ${p.meanAfter!.toFixed(2)} ${units}). It can be a real shift in the climate system or a data artefact such as a sensor or record change — this test cannot tell which.`
  if (!p.stepBetter) {
    s += ' A steady trend also triggers this test, and here a straight line fits at least as well as a single step, so this may simply be the trend.'
  }
  return s
}

// ---- two-region difference -------------------------------------------------

export function relationText(rel: RegionRelation, nameA: string, nameB: string): string {
  switch (rel) {
    case 'a-contains-b': return `${nameA} contains ${nameB}`
    case 'b-contains-a': return `${nameB} contains ${nameA}`
    case 'same': return `${nameA} and ${nameB} cover the same area`
    default: return `${nameA} and ${nameB} partly overlap`
  }
}

export function differenceHeadline(d: SlopeDifference, approximate: boolean): string {
  if (d.label === 'insufficient-data') return 'Not enough overlapping years to compare the trends.'
  const base = d.label === 'differ' ? 'The trends differ significantly' : 'No evidence the trends differ'
  return approximate ? `${base} (approximate)` : base
}

export function differenceDetail(d: SlopeDifference, unitsShort: string): string {
  if (d.label === 'insufficient-data') return `Only ${d.n} years are shared by both series.`
  const dec = d.diff! * 10
  const lo = d.ciLow! * 10, hi = d.ciHigh! * 10
  const core = `Difference in trend (A − B): ${signed(dec)} ${unitsShort} per decade (95% CI ${signed(lo)} to ${signed(hi)}), ${pEq(d.p!)}, using the ${d.n} years both series share.`
  return d.label === 'differ'
    ? core
    : `${core} That is not proof the trends are the same — the data cannot rule out a difference anywhere inside that range.`
}

// ---- window robustness -------------------------------------------------------

/** Extra sentence when the window chosen in the workspace disagrees with the
 *  verdict most windows give (e.g. detected in the chosen window only). */
export function selectedWindowNote(r: Robustness, selectedLabel: string | undefined): string {
  if (!selectedLabel || selectedLabel === 'insufficient-data' || r.verdict === 'insufficient-data') return ''
  const detected = selectedLabel === 'detected-increase' || selectedLabel === 'detected-decrease'
  if (r.verdict === 'robust-none' && detected) {
    return ' Your chosen window does detect a trend, but most other windows do not, so treat that detection as fragile.'
  }
  if ((r.verdict === 'robust-increase' || r.verdict === 'robust-decrease') && !detected) {
    return ' Your chosen window happens to show no clear trend, although most other windows detect one.'
  }
  return ''
}

export function robustnessSentence(r: Robustness, minYears: number): string {
  const n = r.nWindows
  if (r.verdict === 'insufficient-data') {
    return `Not enough data for any window of ${minYears}+ years.`
  }
  const windows = `${n} window${n === 1 ? '' : 's'} of ${minYears}+ years`
  const inc = r.nIncrease / n, dec = r.nDecrease / n, none = r.nNone / n
  switch (r.verdict) {
    case 'robust-increase':
      return `Detected increase in ${pct(inc)} of the ${windows} — the finding holds regardless of the dates chosen.`
    case 'robust-decrease':
      return `Detected decrease in ${pct(dec)} of the ${windows} — the finding holds regardless of the dates chosen.`
    case 'robust-none':
      return `No detected trend in ${pct(none)} of the ${windows} — consistently no clear trend, whatever the dates.`
    default: {
      const parts: string[] = []
      if (r.nIncrease) parts.push(`increase in ${pct(inc)}`)
      if (r.nDecrease) parts.push(`decrease in ${pct(dec)}`)
      if (r.nNone) parts.push(`no detected trend in ${pct(none)}`)
      return `Detected ${parts.join(', ')} of the ${windows} — the finding depends on the dates chosen.`
    }
  }
}
