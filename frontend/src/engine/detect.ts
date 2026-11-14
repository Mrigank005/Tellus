/**
 * S6 — "Not significant yet" estimate: how many more years would this trend
 * need before the persistence-adjusted test could call it significant?
 *
 * Deterministic OLS-power solve in the spirit of Weatherhead et al. (1998):
 * with slope b, residual spread s and lag-1 persistence r, the t-statistic of
 * the slope for a record of n years grows like
 *   t(n) = |b| * sqrt(n(n^2-1)/12) / (s * sqrt((1+r)/(1-r)))
 * and we need t(n) >= t_crit(alpha, n_eff - 2). We solve numerically for the
 * smallest n (never below the current record length) and report the extra
 * years, capped at 50. This is an estimate under the assumption that the
 * current slope and noise persist — the app says so.
 */
import { studentTTwoSidedP } from './stats'

export interface DetectionHorizon {
  moreYears: number | null  // null => not within the cap
  totalYears: number | null
  assumedSlope: number      // per year
  persistenceR: number
  cappedAt: number
}

export function detectionHorizon(
  n: number, slopePerYear: number, residualSd: number, lag1R: number,
  alpha = 0.05, cap = 50,
): DetectionHorizon {
  const r = Math.min(Math.max(lag1R, 0), 0.95)
  const infl = Math.sqrt((1 + r) / (1 - r))
  const b = Math.abs(slopePerYear)
  const s = Math.abs(residualSd)
  const out: DetectionHorizon = {
    moreYears: null, totalYears: null,
    assumedSlope: slopePerYear, persistenceR: r, cappedAt: cap,
  }
  if (!Number.isFinite(b) || !Number.isFinite(s) || b === 0 || s === 0) return out

  for (let m = n; m <= n + cap; m++) {
    const sxx = m * (m * m - 1) / 12
    const t = b * Math.sqrt(sxx) / (s * infl)
    const nEff = Math.min(Math.max(m * (1 - r) / (1 + r), 3), m)
    const dof = Math.max(3, Math.trunc(nEff) - 2)
    if (t > 0 && studentTTwoSidedP(t, dof) < alpha) {
      out.totalYears = m
      out.moreYears = m - n
      return out
    }
  }
  return out
}

/** Residual standard deviation around a fitted slope (used as the noise term). */
export function residualSd(values: number[]): number {
  const n = values.length
  if (n < 3) return NaN
  let xm = 0, ym = 0
  for (let i = 0; i < n; i++) { xm += i; ym += values[i] }
  xm /= n; ym /= n
  let sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (i - xm) * (i - xm)
    sxy += (i - xm) * (values[i] - ym)
  }
  const slope = sxy / sxx
  let sse = 0
  for (let i = 0; i < n; i++) {
    const e = values[i] - (ym + slope * (i - xm))
    sse += e * e
  }
  return Math.sqrt(sse / (n - 2))
}
