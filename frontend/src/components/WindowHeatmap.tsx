import { useMemo } from 'react'
import { useChart } from '../hooks/useChart'
import { useTheme } from '../state/theme'
import { chartBase, dataScale } from '../styles/tokens'
import { Icon } from './Icon'
import { windowScan, LABELS } from '../engine/stats'
import { robustnessSentence, selectedWindowNote, fmtP } from '../engine/narrative'
import type { AnalysisConfig } from '../engine/analysis'

/**
 * Start-year x end-year heat map: the persistence-adjusted verdict and Sen
 * slope of EVERY window of at least `minYears` years in the record.
 * Colour = slope per decade (diverging data scale, symmetric around zero: it encodes
 * direction and size, not good or bad). Windows where the trend is NOT statistically
 * detected are faded and hatched; detected windows are solid and carry an ink dot.
 * The robustness line summarises how many windows agree.
 */
export default function WindowHeatmap({ years, values, cfg, trendUnits, selected }: {
  years: number[]
  values: (number | null)[]
  cfg: AnalysisConfig
  trendUnits: string
  /** the window currently chosen in the workspace (outlined on the map) */
  selected?: { start: number; end: number }
}) {
  const theme = useTheme((s) => s.theme)
  const scan = useMemo(
    () => windowScan(years, values.map((v) => (v === null ? NaN : v)),
      cfg.minYears, cfg.alpha, cfg.cautionYears),
    [years, values, cfg.minYears, cfg.alpha, cfg.cautionYears],
  )

  const vmax = useMemo(() => {
    let m = 1e-9
    for (const w of scan.windows) {
      if (w.slope !== null && w.label !== LABELS.insufficientData) m = Math.max(m, Math.abs(w.slope * 10))
    }
    return m
  }, [scan])

  const option = useMemo(() => {
    const base = chartBase(theme)
    const t = base.t
    const cells = scan.windows.filter((w) => w.slope !== null && w.label !== LABELS.insufficientData)
    const starts = Array.from(new Set(cells.map((w) => w.start))).sort((a, b) => a - b)
    const ends = Array.from(new Set(cells.map((w) => w.end))).sort((a, b) => a - b)
    const xi = new Map(starts.map((v, i) => [v, i]))
    const yi = new Map(ends.map((v, i) => [v, i]))
    const isDetected = (l: string) => l === LABELS.detectedIncrease || l === LABELS.detectedDecrease
    const mk = (w: (typeof cells)[number]) => {
      const isSel = !!selected && selected.start === w.start && selected.end === w.end
      return {
        value: [xi.get(w.start)!, yi.get(w.end)!, +(w.slope! * 10).toFixed(4)],
        ...(isSel ? { itemStyle: { borderColor: t.ink, borderWidth: 3, opacity: 1 } } : {}),
      }
    }
    const heatDetected = cells.filter((w) => isDetected(w.label)).map(mk)
    const heatFaded = cells.filter((w) => !isDetected(w.label)).map(mk)
    const dots = cells.filter((w) => isDetected(w.label)).map((w) => [xi.get(w.start)!, yi.get(w.end)!])
    const byKey = new Map(cells.map((w) => [`${xi.get(w.start)}|${yi.get(w.end)}`, w]))
    const cellBorder = { borderColor: t.paper, borderWidth: 0.5 }
    return {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      grid: { left: 68, right: 18, top: 14, bottom: 44 },
      tooltip: {
        ...base.tooltip, trigger: 'item',
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
        type: 'category', data: starts, name: 'start year', nameLocation: 'middle', nameGap: 28,
        ...base.axis,
        axisLabel: { ...base.axis.axisLabel, interval: 1, hideOverlap: true }, splitLine: { show: false }, splitArea: { show: false },
      },
      yAxis: {
        type: 'category', data: ends, name: 'end year', nameLocation: 'middle', nameGap: 46,
        ...base.axis, axisLabel: { ...base.axis.axisLabel, interval: 1, hideOverlap: true }, splitLine: { show: false },
      },
      visualMap: {
        show: false, type: 'continuous', min: -vmax, max: vmax, dimension: 2, seriesIndex: [0, 1],
        inRange: { color: dataScale(theme) },
      },
      series: [
        {
          name: 'slope (detected)', type: 'heatmap', data: heatDetected,
          itemStyle: cellBorder,
          emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
        },
        {
          name: 'slope (not detected)', type: 'heatmap', data: heatFaded,
          itemStyle: {
            ...cellBorder, opacity: 0.4,
            decal: {
              symbol: 'rect', symbolSize: 1, rotation: Math.PI / 4, dashArrayX: [1, 0], dashArrayY: [1.2, 3.2],
              color: theme === 'dusk' ? 'rgba(238,231,210,.55)' : 'rgba(22,48,42,.5)',
            },
          },
          emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
        },
        {
          name: 'detected', type: 'scatter', data: dots, symbol: 'circle', symbolSize: 4,
          itemStyle: { color: t.ink, borderColor: t.paperRaised, borderWidth: 0.8 }, silent: true, z: 5,
        },
      ],
    }
  }, [scan, selected, trendUnits, theme, vmax])

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

  const stampClass = robust ? (r.verdict === 'robust-increase' ? 'up' : r.verdict === 'robust-decrease' ? 'down' : 'none') : 'partial'

  return (
    <div className="heat">
      <div className="heat-head">
        <span className={`stamp ${stampClass}`}>
          <Icon name={robust ? 'check' : 'tilde'} />{robust ? 'Robust' : 'Depends on the dates'}
        </span>
        <span className="heat-sentence">{robustnessSentence(r, cfg.minYears)}{note}</span>
      </div>
      <div ref={ref} className="chart-lg heat-chart" style={{ height: 400 }} role="img"
        aria-label={`Heat map of the trend per decade (${trendUnits}) for every start year and end year window. ${robustnessSentence(r, cfg.minYears)}`} />
      <div className="heat-legend" aria-hidden="true">
        <span className="num">−{vmax.toFixed(2)}</span>
        <span className="scale-bar" />
        <span className="num">+{vmax.toFixed(2)}</span>
        <span className="heat-key"><i className="heat-swatch hatch" />Not detected (faded, hatched)</span>
        <span className="heat-key"><i className="heat-dot" />Detected</span>
        {selected && <span className="heat-key"><i className="heat-outline" />Window chosen in the desk</span>}
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Each cell is one possible analysis window: x = start year, y = end year, colour = trend per decade
        ({trendUnits}; ember = rising, tide = falling, pale = near zero). Solid cells with a dot are windows
        where the trend is statistically detected after the persistence adjustment; faded hatched cells are
        not. {r.nWindows} windows of {cfg.minYears}+ years
        are tested; they overlap heavily, so this is a robustness summary, not an extra p-value. Robust =
        at least 80% of windows detect the same direction and at most 5% the opposite one.
        {selected ? ' The ink outline marks the window currently chosen in the workspace.' : ''}
      </p>
    </div>
  )
}
