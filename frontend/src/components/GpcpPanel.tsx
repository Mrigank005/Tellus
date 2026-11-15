import { useMemo } from 'react'
import type { GpcpData, Presets } from '../engine/loader'
import type { AnalysisConfig, RegionAnalysis } from '../engine/analysis'
import { regionAnalysis } from '../engine/analysis'
import { summarize, type Summarized } from '../engine/stats'
import { useChart } from '../hooks/useChart'
import ChartLegend from './ChartLegend'
import { useTheme } from '../state/theme'
import { chartBase } from '../styles/tokens'
import { Icon } from './Icon'

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

  const theme = useTheme((s) => s.theme)
  const option = useMemo(() => {
    if (!obs || !model) return null
    const base = chartBase(theme)
    const t = base.t
    const modelVals = model.series.values as number[]
    return {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      grid: { left: 58, right: 18, top: 30, bottom: 34 },
      tooltip: {
        ...base.tooltip, trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.copper, type: 'dashed', width: 1 } },
      },
      xAxis: { type: 'value', min: windowStart, max: windowEnd, ...base.axis, name: '', axisLabel: { ...base.axis.axisLabel, formatter: (v: number) => String(v), hideOverlap: true }, },
      yAxis: {
        type: 'value', scale: true, ...base.axis,
        name: 'mm/yr', nameTextStyle: { ...base.axis.nameTextStyle, align: 'left' },
      },
      series: [
        {
          name: 'Model · MERRA-2 (POWER)', type: 'line', symbol: 'diamond', symbolSize: 5,
          data: model.years.map((y, i) => [y, Number.isFinite(modelVals[i]) ? +modelVals[i].toFixed(1) : null]),
          lineStyle: { width: 1.6, color: t.leaf },
          itemStyle: { color: t.paperRaised, borderColor: t.leaf, borderWidth: 1.5 }, z: 2,
        },
        {
          name: 'Observed · GPCP V2.3', type: 'line', symbol: 'circle', symbolSize: 6,
          data: obs.years.map((y, i) => [y, Number.isFinite(obs.values[i]) ? +obs.values[i].toFixed(1) : null]),
          lineStyle: { width: 1.6, color: t.ink },
          itemStyle: { color: t.paperRaised, borderColor: t.ink, borderWidth: 1.5 }, z: 3,
        },
      ],
    }
  }, [obs, model, windowStart, windowEnd, theme])

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
  const fmt = (x: number) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}` : '—'
  const dir = (x: number) => (Number.isFinite(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : '') : '')
  const stampFor = (sm: unknown) => {
    const l = (sm as { label?: string } | undefined)?.label
    return l === 'detected-increase' ? { c: 'up', t: 'Detected increase' }
      : l === 'detected-decrease' ? { c: 'down', t: 'Detected decrease' }
      : l === 'no-detected-trend' ? { c: 'none', t: 'No clear trend' }
      : { c: 'na', t: 'Too little data' }
  }
  const sm = stampFor(ms), so = stampFor(os)

  return (
    <section className="xpanel">
      <div className="xpanel-head">
        <h3>Model vs observed: annual precipitation in {regionName}</h3>
        <div className="xpanel-sources">
          <a className="source" href="https://power.larc.nasa.gov/" target="_blank" rel="noopener">
            <Icon name="sat" />NASA POWER · MERRA-2 (model)
          </a>
          <a className="source" href="https://psl.noaa.gov/data/gridded/data.gpcp.html" target="_blank" rel="noopener">
            <Icon name="drop" />GPCP V2.3 · NOAA PSL (observed)
          </a>
        </div>
      </div>
      <ChartLegend items={[
        { label: 'Model · MERRA-2 (POWER)', color: 'var(--leaf)', line: 'solid', dot: 'diamond' },
        { label: 'Observed · GPCP V2.3', color: 'var(--ink)', line: 'solid', dot: 'circle' },
      ]} />
      {option && (
        <div ref={ref} className="chart" role="img"
          aria-label={`Annual precipitation in ${regionName}: MERRA-2 model series and GPCP observed series, in mm per year.`} />
      )}
      <div className="xledger" role="list">
        <div className="xrow" role="listitem">
          <span className="xsw diamond leaf" aria-hidden="true" />
          <span className="xkey">MERRA-2<small>model, trend per decade</small></span>
          <span className={`xval ${dir(msSlope)}`}>{fmt(msSlope)} <small>mm/decade</small></span>
          <span className={`stamp ${sm.c}`}>{sm.t}</span>
        </div>
        <div className="xrow" role="listitem">
          <span className="xsw ink" aria-hidden="true" />
          <span className="xkey">GPCP observed<small>satellite + rain gauges, trend per decade</small></span>
          <span className={`xval ${dir(osSlope)}`}>{fmt(osSlope)} <small>mm/decade</small></span>
          <span className={`stamp ${so.c}`}>{so.t}</span>
        </div>
      </div>
      <div className="verdict">
        {!agree ? (
          <>
            <span className="stamp partial"><Icon name="x" />Disagree in direction</span>
            <div className="divergebox">
              <b>The model and the observations disagree in direction here.</b> Reanalysis
              precipitation is model-generated even where it uses observed inputs; when the two
              disagree, the observed record (GPCP, satellite + rain gauges) is the reference for
              “what fell”. This is exactly why Tellus never shows the model alone.
            </div>
          </>
        ) : (
          <>
            <span className="stamp pass"><Icon name="check" />Agree in direction</span>
            <p className="muted small">
              Model and observed records agree in direction{obsSig ? ', and the observed trend is itself statistically detected' : ''}.
              GPCP V2.3 is a 2.5° satellite–gauge product; coarse cells smooth regional detail.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
