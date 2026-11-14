/**
 * Run the TypeScript engine on the shared parity series.
 * Usage (from frontend/): npm run parity   -> writes tests/parity/parity_ts.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classify, erf, fdrAdjust, mannKendall, normPpf, ols, pettitt, senSlopeAndCI,
  slopeDifference, studentTTwoSidedP, summarize, timeOfEmergence, windowScan,
} from '../../frontend/src/engine/stats'

const here = dirname(fileURLToPath(import.meta.url))

interface Doc {
  series: { id: string; x: number[]; y: number[] }[]
  pvals: number[]
}

const doc: Doc = JSON.parse(readFileSync(join(here, 'series.json'), 'utf8'))

const out: Record<string, Record<string, unknown>> = {
  series: {}, fdr: {}, special: {}, emergence: {}, windows: {}, slopediff: {}, pettitt: {},
}

const nul = (v: number | boolean | undefined | null) => (v === undefined ? null : v)

doc.series.forEach((s, i) => {
  const pt = pettitt(s.x, s.y)
  out.pettitt[s.id] = {
    n: pt.n, K: nul(pt.K), t: nul(pt.t), p: nul(pt.p), p_adj: nul(pt.pAdj),
    year: nul(pt.year), year_before: nul(pt.yearBefore),
    mean_before: nul(pt.meanBefore), mean_after: nul(pt.meanAfter),
    sse_step: nul(pt.sseStep), sse_line: nul(pt.sseLine),
    step_better: nul(pt.stepBetter), var_factor: nul(pt.varFactor), lag1_r: nul(pt.lag1R),
  }
  if (i % 2 === 0 && s.x.length >= 22) {
    const e = timeOfEmergence(s.x, s.y)
    out.emergence[s.id] = {
      status: e.status, emergence_year: e.emergenceYear,
      at_earliest: e.atEarliest, ever_detected: e.everDetected,
      path: e.path.map((p) => p.label),
    }
  }
  if (i % 15 === 0 && s.x.length >= 30) {
    const w = windowScan(s.x, s.y)
    out.windows[s.id] = {
      labels: w.windows.map((c) => c.label),
      slopes: w.windows.map((c) => c.slope),
      verdict: w.robustness.verdict,
      n_increase: w.robustness.nIncrease, n_decrease: w.robustness.nDecrease,
      share: w.robustness.share,
    }
  }
  if (i % 2 === 0 && i + 1 < doc.series.length) {
    const o = doc.series[i + 1]
    const d = slopeDifference(s.x, s.y, o.x, o.y)
    out.slopediff[`${s.id}|${o.id}`] = {
      label: d.label, n: d.n, slope_a: nul(d.slopeA), slope_b: nul(d.slopeB),
      se_a: nul(d.seA), se_b: nul(d.seB), diff: nul(d.diff), se_diff: nul(d.seDiff),
      z: nul(d.z), df: nul(d.df), p: nul(d.p), ci_low: nul(d.ciLow), ci_high: nul(d.ciHigh),
    }
  }
})

for (const s of doc.series) {
  const mk = mannKendall(s.y)
  const sen = senSlopeAndCI(s.x, s.y, mk.varS)
  const o = ols(s.x, s.y)
  const summ = summarize(s.x, s.y) as { label: string; caution?: boolean }
  const t = summ as { varFactor?: number, lag1R?: number, nEff?: number,
    mkPAdj?: number, ciAdjLow?: number, ciAdjHigh?: number, olsPAdj?: number }
  out.series[s.id] = {
    S: mk.S, var_s: mk.varS, z: mk.z, p: mk.p,
    sen: sen.slope, ci_low: sen.ciLow, ci_high: sen.ciHigh,
    ols_slope: o.slope, ols_t: o.t, ols_p: o.p, ols_r2: o.r2,
    var_factor: t.varFactor, lag1_r: t.lag1R, n_eff: t.nEff,
    mk_p_adj: t.mkPAdj, ci_adj_low: t.ciAdjLow, ci_adj_high: t.ciAdjHigh,
    ols_p_adj: t.olsPAdj,
    label: summ.label, caution: summ.caution,
  }
}

out.fdr = { bh: fdrAdjust(doc.pvals, 'bh'), by: fdrAdjust(doc.pvals, 'by') }
out.special = {
  erf_05: erf(0.5), erf_2: erf(2.0), erf_neg1: erf(-1.0),
  norm_ppf_975: normPpf(0.975),
  t_p_2_10: studentTTwoSidedP(2.0, 10),
  t_p_3_44: studentTTwoSidedP(3.0, 44),
}

writeFileSync(join(here, 'parity_ts.json'), JSON.stringify(out))
console.log(`TypeScript engine ran on ${doc.series.length} series -> parity_ts.json`)
// silence unused import lint in some configs
void classify
