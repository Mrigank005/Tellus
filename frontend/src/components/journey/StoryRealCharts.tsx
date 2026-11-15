import { useRef } from 'react'
import { senSlopeAndCI, medianSorted } from '../../engine/stats'
import { fmtSigned, type JourneyVerdict } from './StoryVerdict'
import { niceTicks, useWidth, yearTicks } from './StoryChart'

type Tone = 'up' | 'down' | 'none'

/** The real years (dark dots, trend line) against one shuffled order of the same values (open dots). */
export function RealMini({ v, tone, example }: { v: JourneyVerdict; tone: Tone; example: number[] | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const W = useWidth(hostRef, 520)
  const H = W < 480 ? 230 : 260
  const L = 46, R = 12, T = 12, B = 30
  const { years, values, summary } = v
  const n = years.length
  const y0 = years[0], y1 = years[n - 1]
  const lo = Math.min(...values), hi = Math.max(...values)
  let range = hi - lo
  if (!(range > 0)) range = Math.abs(hi) * 0.1 || 1
  const pad = range * 0.1
  const dLo = lo - pad, dHi = hi + pad
  const X = (yr: number) => L + ((yr - y0) / (y1 - y0)) * (W - L - R)
  const Y = (val: number) => T + ((dHi - val) / (dHi - dLo)) * (H - T - B)
  const { ticks, decimals } = niceTicks(dLo, dHi, 4)

  let exLine: [number, number] | null = null
  if (example) {
    const s = senSlopeAndCI(years, example, 1)
    if (Number.isFinite(s.slope)) {
      const ic = medianSorted(example.map((val, i) => val - s.slope * years[i]).sort((a, b) => a - b))
      exLine = [ic + s.slope * y0, ic + s.slope * y1]
    }
  }
  const realLine = summary ? [v.intercept + summary.senSlope * y0, v.intercept + summary.senSlope * y1] : null

  return (
    <div ref={hostRef} className="st-chart-host">
      <svg
        className={`st-chart tone-${tone}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`The ${n} yearly values for ${v.place.mid}${example ? ', and the same values in one shuffled order' : ''}.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} />
            <text x={L - 8} y={Y(t) + 4} textAnchor="end">{t.toFixed(decimals)}</text>
          </g>
        ))}
        {yearTicks(y0, y1, W - L - R).map((yr) => (
          <text key={yr} x={X(yr)} y={H - 8} textAnchor="middle">{yr}</text>
        ))}
        {realLine && (
          <line className={`trend ${tone === 'none' ? 'dashed' : ''}`} x1={X(y0)} y1={Y(realLine[0])} x2={X(y1)} y2={Y(realLine[1])} />
        )}
        {exLine && (
          <line className="trend ghost-line" x1={X(y0)} y1={Y(exLine[0])} x2={X(y1)} y2={Y(exLine[1])} />
        )}
        {years.map((yr, i) => (
          <circle key={`r${yr}`} className="dot" cx={X(yr)} cy={Y(values[i])} r={3.6} />
        ))}
        {example && years.map((yr, i) => (
          <circle
            key={`s${yr}`} className="dot ghost" cx={0} cy={0} r={3.6}
            style={{ transform: `translate(${X(yr).toFixed(1)}px, ${Y(example[i]).toFixed(1)}px)` }}
          />
        ))}
      </svg>
    </div>
  )
}

const BINS = 60

/** How unusual is the real trend score? Shuffled cloud, or the chance curve of the chosen test. */
export function RealHist({
  n, realS, tone, mode, scores, varS, varFactor,
}: {
  n: number; realS: number; tone: Tone; mode: 'naive' | 'shuffled' | 'corrected'
  scores: number[] | null; varS: number; varFactor: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const W = useWidth(hostRef, 520)
  const H = W < 480 ? 230 : 260
  const L = 14, R = 14, T = 16, B = 32
  const max = (n * (n - 1)) / 2
  const X = (s: number) => L + ((s + max) / (2 * max)) * (W - L - R)
  const base = H - B
  const plotH = H - T - B - 34
  const sdNaive = Math.sqrt(varS), sdAdj = Math.sqrt(varS * varFactor)

  const bell = (sd: number, peak: number) => {
    let d = ''
    for (let i = 0; i <= 120; i++) {
      const s = -max + (2 * max * i) / 120
      const h = peak * Math.exp(-(s * s) / (2 * sd * sd))
      d += `${i ? 'L' : 'M'}${X(s).toFixed(1)},${(base - h).toFixed(1)}`
    }
    return d
  }

  let bars: { x: number; h: number; w: number }[] = []
  if (mode === 'shuffled' && scores && scores.length) {
    const bins = new Array(BINS).fill(0)
    for (const s of scores) bins[Math.min(BINS - 1, Math.max(0, Math.floor(((s + max) / (2 * max)) * BINS)))]++
    const top = Math.max(...bins)
    const bw = (W - L - R) / BINS
    bars = bins.map((c, i) => ({ x: L + i * bw + 1, h: c ? (c / top) * plotH : 0, w: bw - 2 })).filter((b) => b.h > 0)
  }
  const rx = X(Math.max(-max, Math.min(max, realS)))
  const peakAdj = plotH * (sdNaive / sdAdj)
  const label = `the real record (${fmtSigned(realS, 0)})`
  const alignEnd = rx > W * 0.55
  const aria = mode === 'shuffled'
    ? (scores && scores.length ? `Histogram of ${scores.length} shuffled trend scores, with the real record's score at ${fmtSigned(realS, 0)}.` : 'Empty histogram. Press Shuffle the years.')
    : `Chance curve for the ${mode} test, with the real record's trend score at ${fmtSigned(realS, 0)}.`

  return (
    <div ref={hostRef} className="st-chart-host">
      <svg className={`st-chart tone-${tone}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria}>
        <line className="axis" x1={L} x2={W - R} y1={base} y2={base} />
        <text x={X(0)} y={H - 9} textAnchor="middle">no trend</text>
        <text x={L} y={H - 9}>falling</text>
        <text x={W - R} y={H - 9} textAnchor="end">rising</text>
        <line className="axis tick" x1={X(0)} x2={X(0)} y1={base} y2={base + 4} />

        {mode === 'shuffled' && bars.map((b, i) => (
          <rect key={i} className="bar" x={b.x} y={base - b.h} width={b.w} height={b.h} rx={2} />
        ))}
        {mode === 'corrected' && <path className="bell ghost-bell" d={bell(sdNaive, plotH)} fill="none" />}
        {mode !== 'shuffled' && (
          <path
            className={`bell ${mode === 'corrected' ? 'wide' : ''}`}
            d={`${bell(mode === 'corrected' ? sdAdj : sdNaive, mode === 'corrected' ? peakAdj : plotH)}L${X(max).toFixed(1)},${base}L${X(-max).toFixed(1)},${base}Z`}
          />
        )}
        <line className="real-mark" x1={rx} x2={rx} y1={T + 12} y2={base} />
        <text className="real-label" x={rx + (alignEnd ? -7 : 7)} y={T + 8} textAnchor={alignEnd ? 'end' : 'start'}>{label}</text>
      </svg>
    </div>
  )
}
