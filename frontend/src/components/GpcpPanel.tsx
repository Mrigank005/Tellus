import { useMemo } from 'react'
import type { GpcpData, Presets } from '../engine/loader'
import type { AnalysisConfig, RegionAnalysis } from '../engine/analysis'
import { regionAnalysis } from '../engine/analysis'
import { summarize, type Summarized } from '../engine/stats'
import { useChart } from '../hooks/useChart'

/** Observed (GPCP) vs model (MERRA-2/POWER) cross-check for precipitation.
 * GPCP totals are annual, so the model series is always the annual one. */
export default function GpcpPanel({ gpcp, regionId, regionName, cfg, presets, windowStart, windowEnd }: {
  gpcp: GpcpData
  regionId: string
  regionName: string
  cfg: AnalysisConfig
  presets: Presets
  windowStart: number
  windowEnd: number
}) {
  const regionData = gpcp.regions[regionId]
  const presetEntry = presets['PRECTOTCORR']?.['annual']?.[regionId]

  const model = useMemo<RegionAnalysis | null>(() => {
    if (!presetEntry) return null
    return regionAnalysis(presetEntry.years, presetEntry.values, presetEntry.n_cells,
      { start: windowStart, end: windowEnd }, cfg)
  }, [presetEntry, windowStart, windowEnd, cfg])

  const obs = useMemo(() => {
    if (!regionData) return null
    const pairs = gpcp.years
      .map((y, i) => ({ y, v: regionData.values[i] }))
      .filter(({ y }) => y >= windowStart && y <= windowEnd)
    const years = pairs.map((p) => p.y)
    const values = pairs.map((p) => (p.v === null ? NaN : p.v))
    const summary = summarize(years, values, cfg.alpha, cfg.minYears, cfg.cautionYears)
    return { years, values, summary }
  }, [gpcp, regionData, cfg, windowStart, windowEnd])

  const option = useMemo(() => {
    if (!obs || !model) return null
    const modelVals = model.series.values as number[]
    return {
      backgroundColor: 'transparent',
      grid: { left: 58, right: 18, top: 34, bottom: 34 },
      tooltip: { trigger: 'axis', backgroundColor: '#101a2c', borderColor: '#233', textStyle: { color: '#e7edf7', fontSize: 12 } },
      legend: { textStyle: { color: '#8b98b0', fontSize: 12 }, top: 2 },
      xAxis: { type: 'value', min: windowStart, axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: '#16213a' } } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: '#16213a' } }, name: 'mm/yr', nameTextStyle: { color: '#8b98b0' } },
      series: [
        {
          name: 'Model · MERRA-2 (POWER)', type: 'line', symbol: 'none',
          data: model.years.map((y, i) => [y, Number.isFinite(modelVals[i]) ? +modelVals[i].toFixed(1) : null]),
          lineStyle: { width: 1.6, color: '#4f9cf9' }, itemStyle: { color: '#4f9cf9' },
        },
        {
          name: 'Observed · GPCP V2.3', type: 'line', symbol: 'circle', symbolSize: 4,
          data: obs.years.map((y, i) => [y, Number.isFinite(obs.values[i]) ? +obs.values[i].toFixed(1) : null]),
          lineStyle: { width: 1.6, color: '#35c48d' }, itemStyle: { color: '#35c48d' },
        },
      ],
    }
  }, [obs, model, windowStart])

  const ref = useChart((option ?? {}) as never)

  if (!regionData || !presetEntry) {
    return (
      <div className="cautionbox">
        <b>Observed cross-check.</b> GPCP covers the preset regions; pick one to compare
        the model against the observed record.
      </div>
    )
  }

  const os = obs?.summary
  const osSlope = os && 'senSlope' in os ? os.senSlope * 10 : NaN
  const ms = model?.summary
  const msSlope = ms && 'senSlope' in ms ? ms.senSlope * 10 : NaN
  const agree = Number.isFinite(osSlope) && Number.isFinite(msSlope)
    && Math.sign(osSlope) === Math.sign(msSlope)
  const obsSig = os && 'label' in os && (os.label === 'detected-increase' || os.label === 'detected-decrease')

  return (
    <div>
      <h3>⚖ Model vs observed — annual precipitation in {regionName}</h3>
      {option && <div ref={ref} className="chart" />}
      <div className="row" style={{ marginTop: 8, gap: 16 }}>
        <span className="mono">MERRA-2: <b>{Number.isFinite(msSlope) ? `${msSlope >= 0 ? '+' : ''}${msSlope.toFixed(1)}` : '—'} mm/decade</b></span>
        <span className="mono">GPCP observed: <b>{Number.isFinite(osSlope) ? `${osSlope >= 0 ? '+' : ''}${osSlope.toFixed(1)}` : '—'} mm/decade</b></span>
      </div>
      {!agree ? (
        <div className="divergebox" style={{ marginTop: 10 }}>
          <b>The model and the observations disagree in direction here.</b> Reanalysis
          precipitation is model-generated even where it uses observed inputs; when the two
          disagree, the observed record (GPCP, satellite + rain gauges) is the reference for
          “what fell”. This is exactly why Tellus never shows the model alone.
        </div>
      ) : (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Model and observed records agree in direction{obsSig ? ', and the observed trend is itself statistically detected' : ''}.
          GPCP V2.3 is a 2.5° satellite–gauge product; coarse cells smooth regional detail.
        </p>
      )}
    </div>
  )
}
