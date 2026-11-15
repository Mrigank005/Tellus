import { useMemo } from 'react'
import { useChart } from '../hooks/useChart'
import ChartLegend, { type LegendItem } from './ChartLegend'
import { useTheme } from '../state/theme'
import { chartBase } from '../styles/tokens'
import type { Summarized } from '../engine/stats'
import type { RegionAnalysis } from '../engine/analysis'

export interface TrendChartProps {
  analysis: RegionAnalysis
  label: string
  /** accepted for compatibility; series colours now come from the design tokens (observed = ink) */
  color?: string
  units: string
  compare?: { analysis: RegionAnalysis; label: string; color?: string }
  height?: number
  /** vertical marker: year the trend became (and stayed) statistically clear */
  emergence?: { year: number; label: string; tooltip: string } | null
  /** vertical dashed marker: exploratory Pettitt change point */
  changePoint?: { x: number; label: string; tooltip: string } | null
}

/**
 * Regional time series with the Sen fit and its confidence band.
 * Colour mapping: observed = ink line with paper-filled dots; Sen trend = ember when a detected trend rises,
 * soft ink when the trend is not detected,
 * tide when it falls; confidence band = copper wash; emergence = leaf; change point = dashed copper;
 * a second region = leaf.
 */
/**
 * Baseline used when two places share one axis: the mean of 1981-2010 when at least
 * 10 of those years have values, else the mean of the whole series. Plotting each place
 * as a difference from its own baseline keeps both trends readable (the Arctic sits near
 * -10 °C and the tropics near +26 °C, which would flatten both lines on one absolute axis).
 */
function baseline(years: number[], vals: ArrayLike<number>): { value: number; label: string } {
  const pick = (lo: number, hi: number) => {
    const xs: number[] = []
    for (let i = 0; i < years.length; i++) if (years[i] >= lo && years[i] <= hi && Number.isFinite(vals[i])) xs.push(vals[i])
    return xs
  }
  const ref = pick(1981, 2010)
  if (ref.length >= 10) return { value: ref.reduce((a, b) => a + b, 0) / ref.length, label: 'its 1981–2010 average' }
  const all = pick(-Infinity, Infinity)
  return { value: all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0, label: 'its own average' }
}

export default function TrendChart(props: TrendChartProps) {
  const { analysis, label, units, compare, height, emergence, changePoint } = props
  const theme = useTheme((s) => s.theme)

  const option = useMemo(() => {
    const base = chartBase(theme)
    const t = base.t
    const years = analysis.years
    // with a second place, both series are drawn as differences from their own baseline
    const baseA = compare ? baseline(years, analysis.series.values) : null
    const vals = Array.from(analysis.series.values).map((v) => (baseA ? v - baseA.value : v))
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
    const rising = !!s && Number.isFinite(s.senSlope) && s.senSlope >= 0
    // colour the fit by direction only when the trend is detected; otherwise keep it quiet
    const detected = !!s && (s.label === 'detected-increase' || s.label === 'detected-decrease')
    const trendColor = !detected ? t.inkSoft : rising ? t.ember : t.tide
    const trendName = !detected ? 'Sen trend (not a clear trend)' : rising ? 'Sen trend (increase)' : 'Sen trend (decrease)'

    const series: object[] = [
      {
        name: label,
        type: 'line',
        data: vals.map((v, i) => [years[i], Number.isFinite(v) ? +v.toFixed(3) : null]),
        symbol: 'circle', symbolSize: 6,
        lineStyle: { width: 1.5, color: t.ink },
        itemStyle: { color: t.paperRaised, borderColor: t.ink, borderWidth: 1.5 },
        z: 3,
      },
    ]
    const markData: object[] = []
    if (emergence) {
      markData.push({
        xAxis: emergence.year, name: emergence.label,
        lineStyle: { color: t.leaf, width: 2, type: 'solid' },
        label: { formatter: emergence.label, color: t.leaf, fontFamily: t.fontBody, fontWeight: 600, fontSize: 11, position: 'insideEndTop' },
        tooltip: { formatter: emergence.tooltip },
      })
    }
    if (changePoint) {
      markData.push({
        xAxis: changePoint.x, name: changePoint.label,
        lineStyle: { color: t.copper, width: 1.5, type: 'dashed' },
        label: { formatter: changePoint.label, color: t.copper, fontFamily: t.fontBody, fontWeight: 600, fontSize: 11, position: 'insideStartTop' },
        tooltip: { formatter: changePoint.tooltip },
      })
    }
    if (markData.length) {
      ;(series[0] as { markLine?: object }).markLine = {
        silent: false, symbol: 'none', animation: false, data: markData,
        tooltip: base.tooltip,
      }
    }
    if (fit.length === 2) {
      series.push({
        name: trendName,
        type: 'line', silent: true, symbol: 'none',
        data: [[years[0], fit[0]], [years[years.length - 1], fit[1] as number]],
        lineStyle: { width: 2.5, color: trendColor, type: 'dashed' },
        itemStyle: { color: trendColor }, tooltip: { show: false }, z: 2,
      })
      series.push({
        name: 'Confidence band', type: 'line', silent: true, symbol: 'none',
        data: [
          [years[0], bandLow[0]], [years[years.length - 1], bandLow[1] as number],
          [years[years.length - 1], bandHigh[1] as number], [years[0], bandHigh[0] as number],
          [years[0], bandLow[0]],
        ],
        lineStyle: { width: 0 }, areaStyle: { color: t.copper, opacity: 0.18 },
        itemStyle: { color: t.copper, opacity: 0.4 }, tooltip: { show: false }, z: 1,
      })
    }

    if (compare) {
      const baseB = baseline(compare.analysis.years, compare.analysis.series.values)
      series.push({
        name: compare.label,
        type: 'line', symbol: 'diamond', symbolSize: 5,
        data: Array.from(compare.analysis.series.values).map((v, i) => [
          compare.analysis.years[i], Number.isFinite(v) ? +(v - baseB.value).toFixed(3) : null,
        ]),
        lineStyle: { width: 1.5, color: t.leaf },
        itemStyle: { color: t.paperRaised, borderColor: t.leaf, borderWidth: 1.5 },
        z: 3,
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
        type: 'value', min: years[0], max: years[years.length - 1],
        ...base.axis, name: '',
        axisLabel: { ...base.axis.axisLabel, formatter: (v: number) => String(v), hideOverlap: true },
      },
      yAxis: {
        type: 'value', scale: true, ...base.axis,
        name: baseA ? `${units}, difference from ${baseA.label}` : units,
        nameTextStyle: { ...base.axis.nameTextStyle, align: 'left' },
      },
      series,
    }
  }, [analysis, label, units, compare, emergence, changePoint, theme])

  const ref = useChart(option as never)
  const sen = analysis.summary as Summarized
  const hasFit = !!sen && Number.isFinite(sen.senSlope)
  const rising = hasFit && sen.senSlope >= 0
  const detectedFit = hasFit && (sen.label === 'detected-increase' || sen.label === 'detected-decrease')
  const items: LegendItem[] = [
    { label, color: 'var(--ink)', line: 'solid', dot: 'circle' },
    ...(hasFit ? [
      { label: !detectedFit ? 'Sen trend (not a clear trend)' : rising ? 'Sen trend (increase)' : 'Sen trend (decrease)', color: !detectedFit ? 'var(--ink-soft)' : rising ? 'var(--ember)' : 'var(--tide)', line: 'dashed' as const },
      { label: 'Confidence band', color: 'var(--copper)', band: true },
    ] : []),
    ...(emergence ? [{ label: 'Time of emergence', color: 'var(--leaf)', line: 'solid' as const }] : []),
    ...(changePoint ? [{ label: 'Possible shift (exploratory)', color: 'var(--copper)', line: 'dashed' as const }] : []),
    ...(compare ? [{ label: compare.label, color: 'var(--leaf)', line: 'solid' as const, dot: 'diamond' as const }] : []),
  ]
  return (
    <>
      <ChartLegend items={items} />
      <div ref={ref} className="chart trend-chart" style={height ? { height } : undefined}
        role="img" aria-label={compare
          ? `${label} and ${compare.label}: yearly values, each as a difference from its own 1981 to 2010 average, in ${units}, with the Sen trend line for ${label}.`
          : `${label}: yearly values with the Sen trend line and its confidence band, in ${units}.`} />
      {compare && (
        <p className="note trend-baseline-note">
          Two places can sit at very different levels, so each line shows how far every year was from that place's own average (1981–2010 where the record allows). The trends themselves are unchanged.
        </p>
      )}
    </>
  )
}
