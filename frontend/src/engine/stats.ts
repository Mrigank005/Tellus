/**
 * Tellus statistical engine (TypeScript).
 *
 * Mirrors pipeline/stats.py exactly; parity is enforced by tests/parity.
 * Methods follow Gilbert (1987) and Helsel & Hirsch (2002).
 *
 * Numeric functions that differ between Python and JavaScript are
 * implemented here to match Python's semantics:
 *   - pyRound: Python's round() uses banker's rounding (half to even).
 *   - erf / erfInv / incompleteBeta: replace scipy/math special functions
 *     with standard high-precision approximations.
 */

export interface MKResult {
  S: number
  varS: number
  z: number
  p: number
  n: number
}

export interface OLSResult {
  slope: number
  intercept: number
  se: number
  t: number
  p: number
  r2: number
}

export interface TrendResult {
  n: number
  senSlope: number
  ciLow: number
  ciHigh: number
  mkS: number
  mkZ: number
  mkP: number
  olsSlope: number
  olsP: number
  olsR2: number
  // persistence-adjusted quantities (AR(1) effective sample size)
  varFactor: number
  lag1R: number
  nEff: number
  mkZAdj: number
  mkPAdj: number
  ciAdjLow: number
  ciAdjHigh: number
  olsPAdj: number
}

export interface Summarized extends TrendResult {
  label: string
  caution: boolean
  cautionReasons: string[]
}

export const LABELS = {
  detectedIncrease: 'detected-increase',
  detectedDecrease: 'detected-decrease',
  noDetectedTrend: 'no-detected-trend',
  insufficientData: 'insufficient-data',
} as const

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26, |error| <= 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

/** Regularized incomplete beta I_x(a, b) via the continued fraction
 * (Numerical Recipes). Used for the Student-t distribution. */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  let y = x
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

function betainc(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) +
      a * Math.log(x) + b * Math.log(1 - x),
  )
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a
  return 1 - (bt * betacf(b, a, 1 - x)) / b
}

/** Two-sided p-value for Student's t with df degrees of freedom. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return NaN
  if (t === 0) return 1
  const x = df / (df + t * t)
  return betainc(df / 2, 0.5, x)
}

/** Inverse standard normal CDF (Acklam's algorithm, |error| < 1.15e-9). */
export function normPpf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416]
  const plow = 0.02425
  if (p < 0 || p > 1) return NaN
  if (p === 0) return -Infinity
  if (p === 1) return Infinity
  let q: number, r: number
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - plow) {
    q = p - 0.5
    r = q * q
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

/** Python's round(): half-to-even. */
export function pyRound(x: number): number {
  if (!Number.isFinite(x)) return x
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

// ---------------------------------------------------------------------------
// Mann-Kendall
// ---------------------------------------------------------------------------

export function mannKendall(values: ArrayLike<number>): MKResult {
  const n = values.length
  if (n < 4) return { S: NaN, varS: NaN, z: NaN, p: NaN, n }
  let S = 0
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) {
      const d = values[j] - values[i]
      S += d > 0 ? 1 : d < 0 ? -1 : 0
    }
  // tie correction
  const counts = new Map<number, number>()
  for (let i = 0; i < n; i++) counts.set(values[i], (counts.get(values[i]) ?? 0) + 1)
  let tieTerm = 0
  counts.forEach((t) => {
    if (t > 1) tieTerm += t * (t - 1) * (2 * t + 5)
  })
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18
  let z = 0
  if (varS > 0 && S !== 0) z = S > 0 ? (S - 1) / Math.sqrt(varS) : (S + 1) / Math.sqrt(varS)
  let p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))
  p = Math.min(1, Math.max(0, p))
  return { S, varS, z, p, n }
}

// ---------------------------------------------------------------------------
// Sen's slope + Gilbert CI
// ---------------------------------------------------------------------------

export interface SenResult {
  slope: number
  ciLow: number
  ciHigh: number
}

/** Median pairwise slope with the Gilbert (1987) confidence interval.
 * Pairwise slopes are computed once and reused for both estimates. */
export function senSlopeAndCI(
  years: ArrayLike<number>,
  values: ArrayLike<number>,
  varS: number,
  conf = 0.95,
): SenResult {
  const n = years.length
  if (n < 2 || !(varS > 0)) return { slope: NaN, ciLow: NaN, ciHigh: NaN }
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = years[j] - years[i]
      if (dx !== 0) slopes.push((values[j] - values[i]) / dx)
    }
  if (slopes.length === 0) return { slope: NaN, ciLow: NaN, ciHigh: NaN }
  slopes.sort((a, b) => a - b)
  const N = slopes.length
  const slope = medianSorted(slopes)
  const zCrit = normPpf(0.5 + conf / 2)
  const c = zCrit * Math.sqrt(varS)
  let rankLow = pyRound((N - c) / 2)
  let rankHigh = pyRound((N + c) / 2) + 1
  rankLow = Math.min(Math.max(rankLow, 1), N)
  rankHigh = Math.min(Math.max(rankHigh, 1), N)
  return { slope, ciLow: slopes[rankLow - 1], ciHigh: slopes[rankHigh - 1] }
}

export function medianSorted(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return NaN
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ---------------------------------------------------------------------------
// OLS + t-test
// ---------------------------------------------------------------------------

export function ols(years: ArrayLike<number>, values: ArrayLike<number>): OLSResult {
  const n = years.length
  const nan = NaN
  if (n < 3) return { slope: nan, intercept: nan, se: nan, t: nan, p: nan, r2: nan }
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += years[i]; sy += values[i] }
  const xm = sx / n, ym = sy / n
  let sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (years[i] - xm) * (years[i] - xm)
    sxy += (years[i] - xm) * (values[i] - ym)
  }
  if (sxx === 0) return { slope: nan, intercept: nan, se: nan, t: nan, p: nan, r2: nan }
  const slope = sxy / sxx
  const intercept = ym - slope * xm
  let sse = 0, sst = 0
  for (let i = 0; i < n; i++) {
    const e = values[i] - (intercept + slope * years[i])
    sse += e * e
    sst += (values[i] - ym) * (values[i] - ym)
  }
  const mse = sse / (n - 2)
  const se = Math.sqrt(mse / sxx)
  const t = se > 0 ? slope / se : NaN
  const p = Number.isFinite(t) ? studentTTwoSidedP(Math.abs(t), n - 2) : NaN
  const r2 = sst > 0 ? 1 - sse / sst : NaN
  return { slope, intercept, se, t, p, r2 }
}

// ---------------------------------------------------------------------------
// FDR
// ---------------------------------------------------------------------------

/** BH or BY adjusted p-values; NaNs preserved. Mirrors scipy-style procedure
 * used in pipeline/stats.py (step-up, monotone enforced via reverse minimum). */
export function fdrAdjust(pvals: number[], method: 'bh' | 'by' = 'bh'): number[] {
  const n = pvals.length
  const out = new Array<number>(n).fill(NaN)
  const idx: number[] = []
  const q: number[] = []
  for (let i = 0; i < n; i++)
    if (Number.isFinite(pvals[i])) { idx.push(i); q.push(pvals[i]) }
  const m = q.length
  if (m === 0) return out
  let scale = 1
  if (method === 'by') {
    let s = 0
    for (let i = 1; i <= m; i++) s += 1 / i
    scale = s
  }
  for (let i = 0; i < m; i++) q[i] = Math.min(q[i] * scale, 1)
  const order = q.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0])
  const adj = new Array<number>(m)
  let running = Infinity
  for (let k = m - 1; k >= 0; k--) {
    const [v, origIdx] = order[k]
    const a = Math.min(running, (v * m) / (k + 1))
    adj[origIdx] = Math.min(Math.max(a, 0), 1)
    running = adj[origIdx]
  }
  for (let i = 0; i < m; i++) out[idx[i]] = adj[i]
  return out
}

// ---------------------------------------------------------------------------
// Persistence (autocorrelation) adjustment — mirrors pipeline/stats.py
// ---------------------------------------------------------------------------

/** Lag-1 autocorrelation of detrended residuals, bias-corrected, clamped
 * to [0, 0.95]: (r(n-1)+1)/(n-3), Marriott-Pope-style. */
export function lag1ResidualAutocorr(
  years: ArrayLike<number>, values: ArrayLike<number>, slope: number,
): number {
  const n = years.length
  if (n < 3) return 0
  let xm = 0, ym = 0
  for (let i = 0; i < n; i++) { xm += years[i]; ym += values[i] }
  xm /= n; ym /= n
  let den = 0, num = 0
  let prev: number | null = null
  for (let i = 0; i < n; i++) {
    const d = (values[i] - ym) - slope * (years[i] - xm)
    den += d * d
    if (prev !== null) num += prev * d
    prev = d
  }
  const r0 = den > 0 ? num / den : 0
  const r = (r0 * (n - 1) + 1) / (n - 3)
  return Math.min(Math.max(r, 0), 0.95)
}

/** (1+r)/(1-r): variance inflation for AR(1) persistence. */
export function persistenceVarianceFactor(r1: number): number {
  const r = Math.min(Math.max(r1, 0), 0.95)
  return (1 + r) / (1 - r)
}

// ---------------------------------------------------------------------------
// Classification + orchestration (mirrors summarize/trend_result)
// ---------------------------------------------------------------------------

export function trendResult(years: number[], values: number[], conf = 0.95): TrendResult | { n: number; label: string } {
  const xs: number[] = [], ys: number[] = []
  for (let i = 0; i < years.length; i++)
    if (Number.isFinite(years[i]) && Number.isFinite(values[i])) { xs.push(years[i]); ys.push(values[i]) }
  const n = xs.length
  if (n < 4) return { n, label: LABELS.insufficientData }
  const mk = mannKendall(ys)
  const sen = senSlopeAndCI(xs, ys, mk.varS, conf)
  const o = ols(xs, ys)

  // persistence adjustment: same factor for MK variance, Sen CI and OLS
  const r1 = lag1ResidualAutocorr(xs, ys, sen.slope)
  const factor = persistenceVarianceFactor(r1)
  const varAdj = mk.varS * factor
  let zAdj = 0
  if (varAdj > 0 && mk.S !== 0) {
    zAdj = mk.S > 0 ? (mk.S - 1) / Math.sqrt(varAdj) : (mk.S + 1) / Math.sqrt(varAdj)
  }
  let pAdj = 2 * (1 - 0.5 * (1 + erf(Math.abs(zAdj) / Math.SQRT2)))
  pAdj = Math.min(1, Math.max(0, pAdj))
  const senAdj = senSlopeAndCI(xs, ys, varAdj, conf)

  const nEff = Math.min(Math.max(n * (1 - r1) / (1 + r1), 3), n)
  const dofAdj = Math.max(3, Math.trunc(nEff) - 2)
  const tAdj = Number.isFinite(o.t) ? o.t / Math.sqrt(factor) : NaN
  const olsPAdj = Number.isFinite(tAdj)
    ? studentTTwoSidedP(Math.abs(tAdj), dofAdj)
    : NaN

  return {
    n,
    senSlope: sen.slope,
    ciLow: sen.ciLow,
    ciHigh: sen.ciHigh,
    mkS: mk.S,
    mkZ: mk.z,
    mkP: mk.p,
    olsSlope: o.slope,
    olsP: o.p,
    olsR2: o.r2,
    varFactor: factor,
    lag1R: r1,
    nEff,
    mkZAdj: zAdj,
    mkPAdj: pAdj,
    ciAdjLow: senAdj.ciLow,
    ciAdjHigh: senAdj.ciHigh,
    olsPAdj,
  }
}

export function classify(
  n: number,
  pAdj: number,
  slope: number,
  olsSlope: number,
  alpha = 0.05,
  minYears = 20,
  cautionYears = 25,
): { label: string; caution: boolean; cautionReasons: string[] } {
  const reasons: string[] = []
  if (n < minYears || pAdj !== pAdj || slope !== slope)
    return {
      label: LABELS.insufficientData,
      caution: false,
      cautionReasons: [`fewer than ${minYears} valid observations`],
    }
  let label: string
  if (pAdj < alpha) {
    label = slope > 0
      ? LABELS.detectedIncrease
      : slope < 0
        ? LABELS.detectedDecrease
        : LABELS.noDetectedTrend
  } else {
    label = LABELS.noDetectedTrend
  }
  if (n < cautionYears) reasons.push(`short series (${n} observations)`)
  if (Number.isFinite(olsSlope) && slope !== 0 && (olsSlope > 0) !== (slope > 0))
    reasons.push('Mann-Kendall and OLS slopes point in opposite directions')
  return { label, caution: reasons.length > 0, cautionReasons: reasons }
}

export function summarize(
  years: number[],
  values: number[],
  alpha = 0.05,
  minYears = 20,
  cautionYears = 25,
  conf = 0.95,
): Summarized | { n: number; label: string } {
  const r = trendResult(years, values, conf)
  if ((r as { label: string }).label === LABELS.insufficientData) return r as { n: number; label: string }
  const t = r as TrendResult
  const c = classify(t.n, t.mkPAdj, t.senSlope, t.olsSlope, alpha, minYears, cautionYears)
  let out: Summarized = { ...t, ...c }
  if (t.mkP < alpha && alpha <= t.mkPAdj) {
    out = {
      ...out,
      caution: true,
      cautionReasons: [...c.cautionReasons, 'detected without the persistence adjustment only'],
    }
  }
  return out
}


// ===========================================================================
// Time-series diagnostics built on the persistence-adjusted verdict.
// Mirrors the second half of pipeline/stats.py (parity-tested).
// ===========================================================================

const DETECTED_LABELS: string[] = [LABELS.detectedIncrease, LABELS.detectedDecrease]

function cleanSorted(years: ArrayLike<number>, values: ArrayLike<number>): { x: number[]; y: number[] } {
  const idx: number[] = []
  for (let i = 0; i < years.length; i++)
    if (Number.isFinite(years[i]) && Number.isFinite(values[i])) idx.push(i)
  idx.sort((a, b) => years[a] - years[b] || a - b)   // stable
  return { x: idx.map((i) => years[i]), y: idx.map((i) => values[i]) }
}

type MaybeSummary = { n: number; label: string; senSlope?: number; mkPAdj?: number }

// ---- 1. time of emergence -------------------------------------------------

export interface EmergencePoint {
  end: number
  label: string
  slope: number | null
  pAdj: number | null
}

export interface Emergence {
  status: 'emerged' | 'not-emerged' | 'insufficient-data'
  emergenceYear: number | null
  direction: number
  lastYear: number | null
  firstTestableYear: number | null
  yearsBeforeEnd: number | null
  atEarliest: boolean
  everDetected: boolean
  path: EmergencePoint[]
}

/** Year in which a trend became (and stayed) statistically clear: the first
 * end year e such that the persistence-adjusted verdict on [first, e] is
 * detected with the same sign as the full-window verdict, for e and every
 * later end year. See pipeline/stats.py `time_of_emergence`. */
export function timeOfEmergence(
  years: ArrayLike<number>, values: ArrayLike<number>,
  minYears = 20, alpha = 0.05, cautionYears = 25,
): Emergence {
  const { x, y } = cleanSorted(years, values)
  const empty: Emergence = {
    status: 'insufficient-data', emergenceYear: null, direction: 0, lastYear: null,
    firstTestableYear: null, yearsBeforeEnd: null, atEarliest: false,
    everDetected: false, path: [],
  }
  if (x.length === 0) return empty
  const firstEnd = x[0] + minYears - 1
  const ends = Array.from(new Set(x)).filter((e) => e >= firstEnd)
  if (ends.length === 0) return empty

  const path: EmergencePoint[] = []
  for (const e of ends) {
    let m = 0
    while (m < x.length && x[m] <= e) m++
    const s = summarize(x.slice(0, m), y.slice(0, m), alpha, minYears, cautionYears) as MaybeSummary
    path.push({
      end: Math.round(e), label: s.label,
      slope: s.senSlope ?? null, pAdj: s.mkPAdj ?? null,
    })
  }
  const full = path[path.length - 1].label
  const lastYear = path[path.length - 1].end
  const out: Emergence = {
    status: 'not-emerged', emergenceYear: null, direction: 0, lastYear,
    firstTestableYear: path[0].end, yearsBeforeEnd: null, atEarliest: false,
    everDetected: path.some((p) => DETECTED_LABELS.includes(p.label)), path,
  }
  if (!DETECTED_LABELS.includes(full)) return out
  let k = path.length - 1
  while (k > 0 && path[k - 1].label === full) k--
  return {
    ...out,
    status: 'emerged',
    direction: full === LABELS.detectedIncrease ? 1 : -1,
    emergenceYear: path[k].end,
    yearsBeforeEnd: lastYear - path[k].end,
    atEarliest: k === 0,
  }
}

// ---- 2. difference of two regional trends --------------------------------

/** t such that P(|T| > t) = 1 - conf (two-sided quantile), by bisection. */
export function studentTQuantile(conf: number, df: number): number {
  const target = 1 - conf
  let lo = 0, hi = 1
  while (studentTTwoSidedP(hi, df) > target && hi < 1e6) hi *= 2
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (studentTTwoSidedP(mid, df) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

interface AdjOLS { slope: number; se: number; dof: number; lag1R: number; nEff: number }

function adjustedOLS(x: number[], y: number[]): AdjOLS {
  const n = x.length
  const o = ols(x, y)
  const slope = senSlopeAndCI(x, y, mannKendall(y).varS, 0.95).slope
  const r1 = lag1ResidualAutocorr(x, y, slope)
  const factor = persistenceVarianceFactor(r1)
  const nEff = Math.min(Math.max(n * (1 - r1) / (1 + r1), 3), n)
  return {
    slope: o.slope, se: o.se * Math.sqrt(factor),
    dof: Math.max(3, Math.trunc(nEff) - 2), lag1R: r1, nEff,
  }
}

export interface SlopeDifference {
  label: 'differ' | 'no-evidence' | 'insufficient-data'
  n: number
  slopeA?: number; slopeB?: number
  seA?: number; seB?: number
  diff?: number; seDiff?: number
  z?: number; df?: number; p?: number
  ciLow?: number; ciHigh?: number
  lag1RA?: number; lag1RB?: number
}

/** Difference of two OLS slopes with persistence-adjusted SEs, on the years
 * both series share. z = (bA-bB)/sqrt(seA^2+seB^2), Student-t with
 * Welch-Satterthwaite df. See pipeline/stats.py `slope_difference`.
 * Slopes are per year. */
export function slopeDifference(
  yearsA: ArrayLike<number>, valuesA: ArrayLike<number>,
  yearsB: ArrayLike<number>, valuesB: ArrayLike<number>,
  minYears = 20, alpha = 0.05, conf = 0.95,
): SlopeDifference {
  const A0 = cleanSorted(yearsA, valuesA)
  const B0 = cleanSorted(yearsB, valuesB)
  const inB = new Map<number, number>()
  B0.x.forEach((yr, i) => inB.set(yr, B0.y[i]))
  const x: number[] = [], a: number[] = [], b: number[] = []
  A0.x.forEach((yr, i) => {
    const vb = inB.get(yr)
    if (vb !== undefined) { x.push(yr); a.push(A0.y[i]); b.push(vb) }
  })
  const n = x.length
  if (n < minYears || n < 5) return { label: 'insufficient-data', n }
  const A = adjustedOLS(x, a), B = adjustedOLS(x, b)
  const va = A.se * A.se, vb = B.se * B.se
  const v = va + vb
  if (!(v > 0) || !Number.isFinite(v)) return { label: 'insufficient-data', n }
  const diff = A.slope - B.slope
  const se = Math.sqrt(v)
  const z = diff / se
  const df = (v * v) / ((va * va) / A.dof + (vb * vb) / B.dof)
  const p = studentTTwoSidedP(Math.abs(z), df)
  const tq = studentTQuantile(conf, df)
  return {
    label: p < alpha ? 'differ' : 'no-evidence',
    n, slopeA: A.slope, slopeB: B.slope, seA: A.se, seB: B.se,
    diff, seDiff: se, z, df, p,
    ciLow: diff - tq * se, ciHigh: diff + tq * se,
    lag1RA: A.lag1R, lag1RB: B.lag1R,
  }
}

// ---- 3. window scan + robustness ------------------------------------------

export const ROBUST_SHARE = 0.8         // >= 80% of windows detect the same direction
export const OPPOSITE_MAX_SHARE = 0.05  // ... and <= 5% detect the opposite one

export type RobustVerdict =
  'robust-increase' | 'robust-decrease' | 'robust-none' | 'depends' | 'insufficient-data'

export interface Robustness {
  nWindows: number
  nTotal: number
  nIncrease: number
  nDecrease: number
  nNone: number
  verdict: RobustVerdict
  share: number
  mixedSigns: boolean
}

export function windowRobustness(labels: string[]): Robustness {
  const labs = labels.filter((l) => l !== LABELS.insufficientData)
  const n = labs.length
  const nInc = labs.filter((l) => l === LABELS.detectedIncrease).length
  const nDec = labs.filter((l) => l === LABELS.detectedDecrease).length
  const nNone = n - nInc - nDec
  const base = { nWindows: n, nTotal: labels.length, nIncrease: nInc, nDecrease: nDec, nNone }
  if (n === 0) return { ...base, verdict: 'insufficient-data', share: 0, mixedSigns: false }
  const si = nInc / n, sd = nDec / n, sn = nNone / n
  let verdict: RobustVerdict, share: number
  if (si >= ROBUST_SHARE && sd <= OPPOSITE_MAX_SHARE) { verdict = 'robust-increase'; share = si }
  else if (sd >= ROBUST_SHARE && si <= OPPOSITE_MAX_SHARE) { verdict = 'robust-decrease'; share = sd }
  else if (sn >= ROBUST_SHARE) { verdict = 'robust-none'; share = sn }
  else { verdict = 'depends'; share = Math.max(si, sd, sn) }
  return { ...base, verdict, share, mixedSigns: si > OPPOSITE_MAX_SHARE && sd > OPPOSITE_MAX_SHARE }
}

export interface WindowCell {
  start: number
  end: number
  n: number
  label: string
  slope: number | null   // Sen slope per year
  pAdj: number | null
}

/** Persistence-adjusted verdict + Sen slope for every window [y0, y1] with
 * y1 - y0 + 1 >= minYears. See pipeline/stats.py `window_scan`. */
export function windowScan(
  years: ArrayLike<number>, values: ArrayLike<number>,
  minYears = 20, alpha = 0.05, cautionYears = 25,
): { windows: WindowCell[]; robustness: Robustness } {
  const { x, y } = cleanSorted(years, values)
  const windows: WindowCell[] = []
  if (x.length) {
    const first = Math.round(x[0]), last = Math.round(x[x.length - 1])
    for (let y0 = first; y0 <= last - minYears + 1; y0++) {
      let lo = 0
      while (lo < x.length && x[lo] < y0) lo++
      for (let y1 = y0 + minYears - 1; y1 <= last; y1++) {
        let hi = lo
        while (hi < x.length && x[hi] <= y1) hi++
        const s = summarize(x.slice(lo, hi), y.slice(lo, hi), alpha, minYears, cautionYears) as MaybeSummary
        windows.push({
          start: y0, end: y1, n: s.n, label: s.label,
          slope: s.senSlope ?? null, pAdj: s.mkPAdj ?? null,
        })
      }
    }
  }
  return { windows, robustness: windowRobustness(windows.map((w) => w.label)) }
}

// ---- 4. Pettitt change-point test -----------------------------------------

export interface PettittResult {
  n: number
  label?: 'insufficient-data'
  K?: number
  t?: number
  sseStep?: number
  sseLine?: number
  stepBetter?: boolean
  yearBefore?: number
  year?: number
  meanBefore?: number
  meanAfter?: number
  p?: number
  pAdj?: number
  varFactor?: number
  lag1R?: number
}

/** Pettitt (1979) change-point test; p = 2 exp(-6K^2/(n^3+n^2)) and its
 * persistence-adjusted version. See pipeline/stats.py `pettitt`. */
export function pettitt(years: ArrayLike<number>, values: ArrayLike<number>): PettittResult {
  const { x, y } = cleanSorted(years, values)
  const n = x.length
  if (n < 10) return { n, label: 'insufficient-data' }
  let u = 0, K = -1, t = 1
  for (let i = 0; i < n - 1; i++) {
    let v = 0
    for (let j = 0; j < n; j++) {
      const d = y[i] - y[j]
      v += d > 0 ? 1 : d < 0 ? -1 : 0
    }
    u += v
    if (Math.abs(u) > K) { K = Math.abs(u); t = i + 1 }
  }
  const denom = n ** 3 + n ** 2
  const p = Math.min(1, 2 * Math.exp((-6 * K * K) / denom))
  const slope = senSlopeAndCI(x, y, mannKendall(y).varS, 0.95).slope
  const r1 = lag1ResidualAutocorr(x, y, slope)
  const factor = persistenceVarianceFactor(r1)
  const pAdj = Math.min(1, 2 * Math.exp((-6 * K * K) / (denom * factor)))
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
  const before = y.slice(0, t), after = y.slice(t)
  const mb = mean(before), ma = mean(after)
  const sseStep = before.reduce((s, v) => s + (v - mb) ** 2, 0)
    + after.reduce((s, v) => s + (v - ma) ** 2, 0)
  const o = ols(x, y)
  let sseLine = 0
  for (let i = 0; i < n; i++) sseLine += (y[i] - (o.intercept + o.slope * x[i])) ** 2
  return {
    n, K, t, sseStep, sseLine, stepBetter: sseStep < sseLine,
    yearBefore: x[t - 1], year: x[t], meanBefore: mb, meanAfter: ma,
    p, pAdj, varFactor: factor, lag1R: r1,
  }
}
