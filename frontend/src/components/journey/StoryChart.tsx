import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { LABELS } from '../../engine/stats'
import { fmtSigned, type JourneyVerdict } from './StoryVerdict'

/** Width of an element, so SVG text stays 12px at every screen size. */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 760): number {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const set = () => setW(Math.max(260, Math.round(el.getBoundingClientRect().width)))
    set()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** Round tick values inside [lo, hi] and the decimals needed to print them. */
export function niceTicks(lo: number, hi: number, count = 5): { ticks: number[]; decimals: number } {
  const range = hi - lo
  if (!(range > 0)) return { ticks: [lo], decimals: 2 }
  const raw = range / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / mag
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t)
  return { ticks, decimals: step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)) }
}

/** Year ticks: round decades inside the record, plus its first and last year (never closer than 46px). */
export function yearTicks(first: number, last: number, plotWidth: number): number[] {
  const span = last - first
  if (span <= 0) return [first]
  const step = span > 25 ? 10 : span > 10 ? 5 : 2
  const px = (yrs: number) => (yrs / span) * plotWidth
  const out: number[] = []
  for (let y = Math.ceil(first / step) * step; y < last; y += step) {
    if (px(y - first) >= 46 && px(last - y) >= 46) out.push(y)
  }
  return [first, ...out, last]
}

export type StoryFocus = 'trend' | 'toe' | 'shift' | 'sure' | null

export function toneOf(label: string): 'up' | 'down' | 'none' {
  return label === LABELS.detectedIncrease ? 'up' : label === LABELS.detectedDecrease ? 'down' : 'none'
}

/** Line path that lifts the pen across missing years. */
function pathOf(xs: number[], ys: number[], years: number[]): string {
  let d = ''
  for (let i = 0; i < xs.length; i++) {
    const gap = i > 0 && years[i] - years[i - 1] > 1
    d += `${i === 0 || gap ? 'M' : 'L'}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`
  }
  return d
}

export function chartAria(v: JourneyVerdict): string {
  const what = `${v.noun} for ${v.place.mid}, ${v.span}`
  const bits = [`Chart of yearly ${what}.`]
  if (v.summary) {
    bits.push(`Trend line: ${fmtSigned(v.slopeDec, v.decimals)} ${v.trendUnits}.`)
    if (v.em?.status === 'emerged') bits.push(`The trend became clear in ${v.em.emergenceYear}.`)
    if (v.cpVisible && v.pt?.year) bits.push(`A possible shift around ${v.pt.year}.`)
  }
  return bits.join(' ')
}

/** The Read chart: yearly dots and line, Sen trend, interval fan, emergence band, change point. */
export function StoryChart({ v, focus }: { v: JourneyVerdict; focus: StoryFocus }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const W = useWidth(hostRef)
  const clipId = useId().replace(/:/g, '')
  const H = W < 560 ? 270 : 330
  const L = 52, R = 18, T = 20, B = 34
  const { years, values, summary } = v
  const n = years.length
  if (n < 2) {
    return <div ref={hostRef} className="st-chart-host"><p className="st-empty-line">Fewer than two valid years, so there is nothing to draw.</p></div>
  }
  const y0 = years[0], y1 = years[n - 1]
  const tone = toneOf(v.label)
  const slope = summary ? summary.senSlope : NaN
  const trendAt = (yr: number) => v.intercept + slope * yr
  let lo = Math.min(...values), hi = Math.max(...values)
  if (summary) { lo = Math.min(lo, trendAt(y0), trendAt(y1)); hi = Math.max(hi, trendAt(y0), trendAt(y1)) }
  let range = hi - lo
  if (!(range > 0)) range = Math.abs(hi) * 0.1 || 1
  const pad = range * 0.12
  const dLo = lo - pad, dHi = hi + pad
  const X = (yr: number) => L + ((yr - y0) / (y1 - y0)) * (W - L - R)
  const Y = (val: number) => T + ((dHi - val) / (dHi - dLo)) * (H - T - B)
  const { ticks, decimals } = niceTicks(dLo, dHi, 4)
  const xs = years.map(X), ys = values.map(Y)
  const lit = (...ks: StoryFocus[]) => (focus && ks.includes(focus) ? 'lit' : '')

  const em = v.em?.status === 'emerged' && v.em.emergenceYear !== null ? v.em.emergenceYear : null
  const shiftX = v.cpVisible && v.pt?.year !== undefined && v.pt.yearBefore !== undefined
    ? (v.pt.yearBefore + v.pt.year) / 2 : null

  // interval fan: the range of slopes the data allow, pivoting on the middle of the record
  let fan: string | null = null
  if (summary && Number.isFinite(v.ciLowDec) && Number.isFinite(v.ciHighDec)) {
    const xc = (y0 + y1) / 2, yc = trendAt(xc)
    const lo10 = v.ciLowDec / 10, hi10 = v.ciHighDec / 10
    const p = (xx: number, s: number) => `${X(xx).toFixed(1)},${Y(yc + s * (xx - xc)).toFixed(1)}`
    fan = `${p(y0, lo10)} ${p(y1, lo10)} ${p(y1, hi10)} ${p(y0, hi10)}`
  }
  const labelEnd = (x: number) => x > W * 0.68

  return (
    <div ref={hostRef} className="st-chart-host">
      <svg
        className={`st-chart tone-${tone}${focus ? ' focus' : ''}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        role="img" aria-label={chartAria(v)}
      >
        <defs><clipPath id={clipId}><rect x={L} y={T - 4} width={W - L - R} height={H - T - B + 8} /></clipPath></defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} />
            <text x={L - 8} y={Y(t) + 4} textAnchor="end">{t.toFixed(decimals)}</text>
          </g>
        ))}
        {yearTicks(y0, y1, W - L - R).map((yr) => (
          <text key={yr} x={X(yr)} y={H - 10} textAnchor="middle">{yr}</text>
        ))}
        <text x={L} y={11}>{v.variable?.units}</text>

        {em !== null && (
          <rect className={`st-hl band ${lit('toe')}`} x={X(em)} y={T} width={Math.max(0, X(y1) - X(em))} height={H - T - B} />
        )}
        {fan && <polygon className={`st-hl fan ${lit('sure')}`} points={fan} clipPath={`url(#${clipId})`} />}

        <path className={`st-hl series ${lit('sure')}${v.cpVisible ? '' : ` ${lit('shift')}`}`} d={pathOf(xs, ys, years)} />
        {xs.map((x, i) => (
          <circle key={years[i]} className={`st-hl dot ${lit('sure')}${v.cpVisible ? '' : ` ${lit('shift')}`}`} cx={x} cy={ys[i]} r={3.4} />
        ))}

        {summary && (
          <line
            className={`st-hl trend ${tone === 'none' ? 'dashed' : ''} ${lit('trend', 'sure')}`}
            x1={X(y0)} y1={Y(trendAt(y0))} x2={X(y1)} y2={Y(trendAt(y1))}
          />
        )}

        {em !== null && (
          <g className={`st-hl toe ${lit('toe')}`}>
            <line x1={X(em)} x2={X(em)} y1={T} y2={H - B} />
            <text x={X(em) + (labelEnd(X(em)) ? -6 : 6)} y={T + 14} textAnchor={labelEnd(X(em)) ? 'end' : 'start'}>
              clear from {em}
            </text>
          </g>
        )}
        {shiftX !== null && v.pt?.year !== undefined && (
          <g className={`st-hl shift ${lit('shift')}`}>
            <line x1={X(shiftX)} x2={X(shiftX)} y1={T + 26} y2={H - B} />
            <text x={X(shiftX) + (labelEnd(X(shiftX)) ? -6 : 6)} y={H - B - 8} textAnchor={labelEnd(X(shiftX)) ? 'end' : 'start'}>
              shift ~{v.pt.year}?
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}

