import { useMemo } from 'react'
import { useChart } from '../hooks/useChart'
import type { Summarized } from '../engine/stats'
import type { RegionAnalysis } from '../engine/analysis'

export interface TrendChartProps {
  analysis: RegionAnalysis
  label: string
  color: string
  units: string
  compare?: { analysis: RegionAnalysis; label: string; color: string }
  height?: number
  /** vertical marker: year the trend became (and stayed) statistically clear */
  emergence?: { year: number; label: string; tooltip: string } | null
  /** vertical dashed marker: exploratory Pettitt change point */
  changePoint?: { x: number; label: string; tooltip: string } | null
}

/** Regional time series with the Sen fit and its confidence band. */
export default function TrendChart(props: TrendChartProps) {
  const { analysis, label, color, units, compare, height, emergence, changePoint } = props

  const option = useMemo(() => {
    const years = analysis.years
    const vals = Array.from(analysis.series.values)
    const s = analysis.summary as Summarized
    const fit: (number | null)[] = []
    const bandLow: (number | null)[] = []
    const bandHigh: (number | null)[] = []

    const valid = vals.map((v, i) => ({ v, y: years[i] })).filter((d) => Number.isFinite(d.v))
    if (valid.length && s && Number.isFinite(s.senSlope)) {
      let wx = 0, wy = 0
      valid.forEach((d) => { wx += d.y; wy += d.v })
      const mx = wx / valid.length, my = wy / valid.length
      const y0 = years[0], y1 = years[years.length - 1]
      const line = (m: number) => [my + m * (y0 - mx), my + m * (y1 - mx)]
      fit.push(...line(s.senSlope))
      bandLow.push(...line(s.ciAdjLow))
      bandHigh.push(...line(s.ciAdjHigh))
    }

    const series: object[] = [
      {
        name: label,
        type: 'line',
        data: vals.map((v, i) => [years[i], Number.isFinite(v) ? +v.toFixed(3) : null]),
        symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 1.5, color }, itemStyle: { color },
      },
    ]
    const markData: object[] = []
    if (emergence) {
      markData.push({
        xAxis: emergence.year, name: emergence.label,
        lineStyle: { color: '#4cc38a', width: 1.5, type: 'solid' },
        label: { formatter: emergence.label, color: '#4cc38a', fontSize: 11, position: 'insideEndTop' },
        tooltip: { formatter: emergence.tooltip },
      })
    }
    if (changePoint) {
      markData.push({
        xAxis: changePoint.x, name: changePoint.label,
        lineStyle: { color: '#ffb547', width: 1.5, type: 'dashed' },
        label: { formatter: changePoint.label, color: '#ffb547', fontSize: 11, position: 'insideStartTop' },
        tooltip: { formatter: changePoint.tooltip },
      })
    }
    if (markData.length) {
      ;(series[0] as { markLine?: object }).markLine = {
        silent: false, symbol: 'none', animation: false, data: markData,
        tooltip: { backgroundColor: '#101a2c', borderColor: '#233', textStyle: { color: '#e7edf7', fontSize: 12 } },
      }
    }
    if (fit.length === 2) {
      series.push({
        name: 'Trend (Sen)', type: 'line', silent: true, symbol: 'none',
        data: [[years[0], fit[0]], [years[years.length - 1], fit[1] as number]],
        lineStyle: { width: 2.5, color, type: 'dashed' }, tooltip: { show: false },
      })
      series.push({
        name: 'CI band', type: 'line', silent: true, symbol: 'none',
        data: [
          [years[0], bandLow[0]], [years[years.length - 1], bandLow[1] as number],
          [years[years.length - 1], bandHigh[1] as number], [years[0], bandHigh[0] as number],
          [years[0], bandLow[0]],
        ],
        lineStyle: { width: 0 }, areaStyle: { color, opacity: 0.12 },
        tooltip: { show: false },
      })
    }

    if (compare) {
      series.push({
        name: compare.label,
        type: 'line', symbol: 'none',
        data: Array.from(compare.analysis.series.values).map((v, i) => [
          compare.analysis.years[i], Number.isFinite(v) ? +v.toFixed(3) : null,
        ]),
        lineStyle: { width: 1.5, color: compare.color }, itemStyle: { color: compare.color },
      })
    }

    return {
      backgroundColor: 'transparent',
      grid: { left: 58, right: 18, top: 34, bottom: 34 },
      tooltip: { trigger: 'axis', backgroundColor: '#101a2c', borderColor: '#233', textStyle: { color: '#e7edf7', fontSize: 12 } },
      legend: { show: !!compare, textStyle: { color: '#8b98b0', fontSize: 12 }, top: 2 },
      xAxis: {
        type: 'value', min: years[0], max: years[years.length - 1],
        axisLine: { lineStyle: { color: '#2a3a5c' } }, axisLabel: { color: '#8b98b0' },
        splitLine: { lineStyle: { color: '#16213a' } }, name: 'year', nameTextStyle: { color: '#8b98b0' },
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: '#16213a' } },
        name: units, nameTextStyle: { color: '#8b98b0' },
      },
      series,
    }
  }, [analysis, label, color, units, compare, emergence, changePoint])

  const ref = useChart(option as never)
  return <div ref={ref} className="chart" style={height ? { height } : undefined} />
}
