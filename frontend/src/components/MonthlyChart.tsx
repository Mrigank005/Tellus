import { useMemo } from 'react'
import { useChart } from '../hooks/useChart'
import ChartLegend from './ChartLegend'
import { useTheme } from '../state/theme'
import { chartBase } from '../styles/tokens'

/**
 * S7 — the seasonal-cycle reveal. Shows the RAW monthly series next to the
 * same series with the average yearly cycle removed, so users see the cycle
 * that hides trends and what removing it exposes.
 */
export default function MonthlyChart({
  months, values, mode, units, regionName,
}: {
  months: number[]
  values: (number | null)[]
  mode: 'monthly' | 'deseasonalised'
  units: string
  /** accepted for compatibility; colours come from the design tokens */
  color?: string
  regionName: string
}) {
  const theme = useTheme((s) => s.theme)
  const option = useMemo(() => {
    const base = chartBase(theme)
    const t = base.t
    const xs = months.map((m) => (m / 100) + ((m % 100) - 0.5) / 12) // decimal years
    let ys: (number | null)[] = values

    if (mode === 'deseasonalised') {
      // monthly climatology over the full record, per calendar month
      const sums = new Map<number, { sum: number; n: number }>()
      values.forEach((v, i) => {
        if (v === null) return
        const mm = months[i] % 100
        const e = sums.get(mm) ?? { sum: 0, n: 0 }
        e.sum += v
        e.n++
        sums.set(mm, e)
      })
      ys = values.map((v, i) => {
        if (v === null) return null
        const e = sums.get(months[i] % 100)!
        return v - e.sum / e.n
      })
    }

    const series: object[] = [
      {
        name: mode === 'monthly' ? 'Monthly values' : 'Deseasonalised anomalies',
        type: 'line', symbol: 'none',
        data: xs.map((x, i) => [x, ys[i] === null ? null : +(ys[i] as number).toFixed(3)]),
        lineStyle: { width: 1.2, color: t.ink }, itemStyle: { color: t.ink },
      },
    ]
    if (mode === 'monthly') {
      // the average yearly cycle, drawn on top so users can see what will be removed
      const clim = new Map<number, { sum: number; n: number }>()
      values.forEach((v, i) => {
        if (v === null) return
        const mm = months[i] % 100
        const e = clim.get(mm) ?? { sum: 0, n: 0 }
        e.sum += v
        e.n++
        clim.set(mm, e)
      })
      const climXs: number[] = []
      const climYs: (number | null)[] = []
      const y0 = Math.floor(months[0] / 100) + 10 // show one cycle mid-record
      for (let mm = 1; mm <= 12; mm++) {
        const e = clim.get(mm)
        climXs.push(y0 + (mm - 0.5) / 12)
        climYs.push(e && e.n ? +(e.sum / e.n).toFixed(3) : null)
      }
      series.push({
        name: 'Average yearly cycle', type: 'line', symbol: 'none',
        data: climXs.map((x, i) => [x, climYs[i]]),
        lineStyle: { width: 3, color: t.copper },
        itemStyle: { color: t.copper }, z: 3,
      })
    }

    return {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      grid: { left: 58, right: 18, top: 30, bottom: 34 },
      tooltip: {
        ...base.tooltip, trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.copper, type: 'dashed', width: 1 } },
      },
      xAxis: {
        type: 'value', min: Math.floor(xs[0]), max: Math.ceil(xs[xs.length - 1]),
        ...base.axis, splitLine: { show: false }, name: '', axisLabel: { ...base.axis.axisLabel, formatter: (v: number) => String(v), hideOverlap: true },
      },
      yAxis: {
        type: 'value', scale: true, ...base.axis,
        name: mode === 'monthly' ? units : `${units} (vs seasonal normal)`,
        nameTextStyle: { ...base.axis.nameTextStyle, align: 'left' },
      },
      series,
    }
  }, [months, values, mode, units, theme])

  const ref = useChart(option as never)
  return (
    <div>
      <ChartLegend items={mode === 'monthly'
        ? [{ label: 'Monthly values', color: 'var(--ink)', line: 'solid' }, { label: 'Average yearly cycle', color: 'var(--copper)', line: 'solid' }]
        : [{ label: 'Deseasonalised anomalies', color: 'var(--ink)', line: 'solid' }]} />
      <div ref={ref} className="chart" role="img"
        aria-label={mode === 'monthly'
          ? `Raw monthly values for ${regionName} with the average yearly cycle, in ${units}.`
          : `Monthly anomalies for ${regionName} with the yearly cycle removed, in ${units}.`} />
      <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
        {mode === 'monthly'
          ? `Raw monthly values for ${regionName}. The thick copper line is the average yearly cycle — the seasonal drumbeat that hides longer trends. Compare the monsoon swing in the raw curve with the slow trend hiding underneath.`
          : 'Same months, yearly cycle removed: each point is that month minus its own long-term average. Now the slow trend and the unusual years stand out.'}
      </p>
    </div>
  )
}
