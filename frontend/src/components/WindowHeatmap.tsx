import { useMemo } from 'react'
import { useChart } from '../hooks/useChart'
import { windowScan, LABELS } from '../engine/stats'
import { robustnessSentence, selectedWindowNote, fmtP } from '../engine/narrative'
import type { AnalysisConfig } from '../engine/analysis'

/**
 * Start-year x end-year heat map: the persistence-adjusted verdict and Sen
 * slope of EVERY window of at least `minYears` years in the record.
 * Colour = slope per decade (diverging, symmetric around zero: it encodes
 * direction and size, not good or bad); a white dot marks windows where the
 * trend is statistically detected. The robustness line summarises how many
 * windows agree.
 */
export default function WindowHeatmap({ years, values, cfg, trendUnits, selected }: {
  years: number[]
  values: (number | null)[]
  cfg: AnalysisConfig
  trendUnits: string
  /** the window currently chosen in the workspace (outlined on the map) */
  selected?: { start: number; end: number }
}) {
  const scan = useMemo(
    () => windowScan(years, values.map((v) => (v === null ? NaN : v)),
      cfg.minYears, cfg.alpha, cfg.cautionYears),
    [years, values, cfg.minYears, cfg.alpha, cfg.cautionYears],
  )

  const option = useMemo(() => {
    const cells = scan.windows.filter((w) => w.slope !== null && w.label !== LABELS.insufficientData)
    const starts = Array.from(new Set(cells.map((w) => w.start))).sort((a, b) => a - b)
    const ends = Array.from(new Set(cells.map((w) => w.end))).sort((a, b) => a - b)
    const xi = new Map(starts.map((v, i) => [v, i]))
    const yi = new Map(ends.map((v, i) => [v, i]))
    let vmax = 1e-9
    for (const w of cells) vmax = Math.max(vmax, Math.abs(w.slope! * 10))
    const heat = cells.map((w) => {
      const isSel = !!selected && selected.start === w.start && selected.end === w.end
      return {
        value: [xi.get(w.start)!, yi.get(w.end)!, +(w.slope! * 10).toFixed(4)],
        ...(isSel ? { itemStyle: { borderColor: '#ffffff', borderWidth: 2.5 } } : {}),
      }
    })
    const dots = cells
      .filter((w) => w.label === LABELS.detectedIncrease || w.label === LABELS.detectedDecrease)
      .map((w) => [xi.get(w.start)!, yi.get(w.end)!])
    const byKey = new Map(cells.map((w) => [`${xi.get(w.start)}|${yi.get(w.end)}`, w]))
    const txt = '#8b98b0'
    return {
      backgroundColor: 'transparent',
      grid: { left: 58, right: 18, top: 14, bottom: 78 },
      tooltip: {
        trigger: 'item', backgroundColor: '#101a2c', borderColor: '#233',
        textStyle: { color: '#e7edf7', fontSize: 12 },
        formatter: (p: { value?: number[] }) => {
          if (!p.value) return ''
          const w = byKey.get(`${p.value[0]}|${p.value[1]}`)
          if (!w) return ''
          const dec = w.slope! * 10
          const verdict = w.label === LABELS.detectedIncrease ? 'detected increase'
            : w.label === LABELS.detectedDecrease ? 'detected decrease' : 'no detected trend'
          return `<b>${w.start}–${w.end}</b> (${w.end - w.start + 1} years)<br/>`
            + `${dec >= 0 ? '+' : ''}${dec.toFixed(3)} ${trendUnits}<br/>`
            + `${verdict} · persistence-adjusted p = ${fmtP(w.pAdj!)}`
        },
      },
      xAxis: {
        type: 'category', data: starts, name: 'start year', nameLocation: 'middle', nameGap: 26,
        nameTextStyle: { color: txt }, axisLabel: { color: txt, interval: 1 },
        axisLine: { lineStyle: { color: '#2a3a5c' } }, splitArea: { show: false },
      },
      yAxis: {
        type: 'category', data: ends, name: 'end year', nameTextStyle: { color: txt },
        axisLabel: { color: txt, interval: 1 }, axisLine: { lineStyle: { color: '#2a3a5c' } },
      },
      visualMap: {
        type: 'continuous', min: -vmax, max: vmax, dimension: 2, seriesIndex: 0,
        orient: 'horizontal', left: 'center', bottom: 6, itemWidth: 12, itemHeight: 220,
        calculable: false, precision: 2, text: [`+${vmax.toFixed(2)}`, `−${vmax.toFixed(2)}`],
        textStyle: { color: txt },
        inRange: { color: ['#4f7fd8', '#2b3550', '#e1694b'] },
      },
      series: [
        {
          name: 'slope', type: 'heatmap', data: heat,
          itemStyle: { borderColor: '#0b1322', borderWidth: 0.5 },
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } },
        },
        {
          name: 'detected', type: 'scatter', data: dots, symbol: 'circle', symbolSize: 4,
          itemStyle: { color: '#ffffff', opacity: 0.92 }, silent: true, z: 5,
        },
      ],
    }
  }, [scan, selected, trendUnits])

  const r = scan.robustness
  const selLabel = selected
    ? scan.windows.find((w) => w.start === selected.start && w.end === selected.end)?.label
    : undefined
  const note = selectedWindowNote(r, selLabel)
  const robust = r.verdict.startsWith('robust') && !note
  const ref = useChart(option as never)

  if (r.verdict === 'insufficient-data') {
    return <p className="muted small">This record is too short for any window of {cfg.minYears}+ years.</p>
  }

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 8, margin: '4px 0 8px' }}>
        <span className={`pill ${robust ? (r.verdict === 'robust-increase' ? 'pill-increase'
          : r.verdict === 'robust-decrease' ? 'pill-decrease' : 'pill-none') : 'pill-insufficient'}`}>
          {robust ? 'robust' : 'depends on the dates'}
        </span>
        <span className="small" style={{ color: 'var(--text)' }}>{robustnessSentence(r, cfg.minYears)}{note}</span>
      </div>
      <div ref={ref} className="chart-lg" style={{ height: 420 }} />
      <p className="muted small" style={{ marginBottom: 0 }}>
        Each cell is one possible analysis window: x = start year, y = end year, colour = trend per decade
        ({trendUnits}; red = rising, blue = falling, dark = near zero). A white dot means the trend is
        statistically detected after the persistence adjustment. {r.nWindows} windows of {cfg.minYears}+ years
        are tested; they overlap heavily, so this is a robustness summary, not an extra p-value. Robust =
        at least 80% of windows detect the same direction and at most 5% the opposite one.
        {selected ? ' The white outline marks the window currently chosen in the workspace.' : ''}
      </p>
    </div>
  )
}
