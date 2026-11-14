import { useMemo } from 'react'
import { useChart } from '../hooks/useChart'

/**
 * S7 — the seasonal-cycle reveal. Shows the RAW monthly series next to the
 * same series with the average yearly cycle removed, so users see the cycle
 * that hides trends and what removing it exposes.
 */
export default function MonthlyChart({
  months, values, mode, units, color, regionName,
}: {
  months: number[]
  values: (number | null)[]
  mode: 'monthly' | 'deseasonalised'
  units: string
  color: string
  regionName: string
}) {
  const option = useMemo(() => {
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
        lineStyle: { width: 1.2, color }, itemStyle: { color },
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
        lineStyle: { width: 3, color: '#ffb547', opacity: 0.9 },
        itemStyle: { color: '#ffb547' },
      })
    }

    return {
      backgroundColor: 'transparent',
      grid: { left: 58, right: 18, top: 34, bottom: 34 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#101a2c', borderColor: '#233',
        textStyle: { color: '#e7edf7', fontSize: 12 },
      },
      legend: { show: mode === 'monthly', textStyle: { color: '#8b98b0', fontSize: 12 }, top: 2 },
      xAxis: {
        type: 'value', min: Math.floor(xs[0]), max: Math.ceil(xs[xs.length - 1]),
        axisLine: { lineStyle: { color: '#2a3a5c' } }, axisLabel: { color: '#8b98b0' },
        splitLine: { show: false }, name: 'year', nameTextStyle: { color: '#8b98b0' },
      },
      yAxis: {
        type: 'value', scale: true, axisLabel: { color: '#8b98b0' },
        splitLine: { lineStyle: { color: '#16213a' } },
        name: mode === 'monthly' ? units : `${units} (vs seasonal normal)`,
        nameTextStyle: { color: '#8b98b0' },
      },
      series,
    }
  }, [months, values, mode, units, color])

  const ref = useChart(option as never)
  return (
    <div>
      <div ref={ref} className="chart" />
      <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
        {mode === 'monthly'
          ? `Raw monthly values for ${regionName}. The thick amber line is the average yearly cycle — the seasonal drumbeat that hides longer trends. Compare the monsoon swing in the raw curve with the slow trend hiding underneath.`
          : 'Same months, yearly cycle removed: each point is that month minus its own long-term average. Now the slow trend and the unusual years stand out.'}
      </p>
    </div>
  )
}
