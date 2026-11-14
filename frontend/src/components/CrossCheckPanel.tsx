import { useMemo } from 'react'
import type { MissionVariable, Missions, Presets, VariableMeta } from '../engine/loader'
import type { AnalysisConfig } from '../engine/analysis'
import { summarize, type Summarized } from '../engine/stats'
import { useChart } from '../hooks/useChart'

/** Model-versus-satellite (or second-model, or station) cross-check for any
 * pair of variables declared as counterparts in config/missions.json
 * (`counters`). Both series are analysed with the same persistence-adjusted
 * engine over the same window; disagreement is shown, never hidden. */

type Entry = { years: number[]; values: (number | null)[] }
type Side = { v: VariableMeta; entry: Entry }
type Pair = { a: Side; b: Side }

const COLORS = ['#4f9cf9', '#35c48d']

function entryFor(id: string, regionId: string, presets: Presets, missions: Missions | null): Entry | null {
  return missions?.[id]?.annual?.[regionId] ?? presets[id]?.annual?.[regionId] ?? null
}

export function findCounterparts(
  variable: VariableMeta, allVars: VariableMeta[], regionId: string,
  presets: Presets, missions: Missions | null,
): Pair[] {
  const me = entryFor(variable.id, regionId, presets, missions)
  if (!me) return []
  const out: Pair[] = []
  const mv = variable as MissionVariable
  for (const other of allVars) {
    if (other.id === variable.id) continue
    const om = other as MissionVariable
    const linked = (mv.counters ?? []).includes(other.id) || (om.counters ?? []).includes(variable.id)
    if (!linked) continue
    const oe = entryFor(other.id, regionId, presets, missions)
    if (oe) out.push({ a: { v: variable, entry: me }, b: { v: other, entry: oe } })
  }
  return out
}

function slice(e: Entry, start: number, end: number) {
  const years: number[] = []
  const values: number[] = []
  e.years.forEach((y, i) => {
    if (y >= start && y <= end) {
      years.push(y)
      values.push(e.values[i] === null ? NaN : (e.values[i] as number))
    }
  })
  return { years, values }
}

function minYearsOf(v: VariableMeta, cfg: AnalysisConfig) {
  const own = (v as VariableMeta & { min_years?: number }).min_years
  return own ?? cfg.minYears
}

function describe(label: string) {
  return label === 'detected-increase' ? 'detected increase'
    : label === 'detected-decrease' ? 'detected decrease'
    : label === 'no-detected-trend' ? 'no detected trend' : 'insufficient data'
}

function PairView({ pair, regionName, cfg, start, end }: {
  pair: Pair; regionName: string; cfg: AnalysisConfig; start: number; end: number
}) {
  const sa = useMemo(() => slice(pair.a.entry, start, end), [pair, start, end])
  const sb = useMemo(() => slice(pair.b.entry, start, end), [pair, start, end])
  const ra = useMemo(() => summarize(sa.years, sa.values, cfg.alpha,
    minYearsOf(pair.a.v, cfg), Math.max(minYearsOf(pair.a.v, cfg), cfg.cautionYears)), [sa, cfg, pair])
  const rb = useMemo(() => summarize(sb.years, sb.values, cfg.alpha,
    minYearsOf(pair.b.v, cfg), Math.max(minYearsOf(pair.b.v, cfg), cfg.cautionYears)), [sb, cfg, pair])

  const sameUnits = pair.a.v.units === pair.b.v.units
  const option = useMemo(() => {
    const mk = (s: Side, ser: { years: number[]; values: number[] }, color: string, axis: number) => ({
      name: s.v.short_name, type: 'line', symbol: 'circle', symbolSize: 3, yAxisIndex: axis,
      data: ser.years.map((y, i) => [y, Number.isFinite(ser.values[i]) ? +ser.values[i].toPrecision(5) : null]),
      lineStyle: { width: 1.6, color }, itemStyle: { color },
    })
    const axis = (name: string, color: string, show: boolean) => ({
      type: 'value', scale: true, name: show ? name : '', nameTextStyle: { color },
      axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: '#16213a' } },
    })
    return {
      backgroundColor: 'transparent',
      grid: { left: 62, right: sameUnits ? 18 : 62, top: 34, bottom: 34 },
      tooltip: { trigger: 'axis', backgroundColor: '#101a2c', borderColor: '#233', textStyle: { color: '#e7edf7', fontSize: 12 } },
      legend: { textStyle: { color: '#8b98b0', fontSize: 12 }, top: 2 },
      xAxis: { type: 'value', min: start, axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: '#16213a' } } },
      yAxis: sameUnits ? [axis(pair.a.v.units, COLORS[0], true)]
        : [axis(pair.a.v.units, COLORS[0], true), axis(pair.b.v.units, COLORS[1], true)],
      series: [mk(pair.a, sa, COLORS[0], 0), mk(pair.b, sb, COLORS[1], sameUnits ? 0 : 1)],
    }
  }, [pair, sa, sb, sameUnits, start])
  const ref = useChart(option as never)

  const slopeOf = (r: Summarized | { n: number; label: string }) =>
    'senSlope' in r ? r.senSlope * 10 : NaN
  const sla = slopeOf(ra as Summarized), slb = slopeOf(rb as Summarized)
  const both = Number.isFinite(sla) && Number.isFinite(slb)
  const agree = both && Math.sign(sla) === Math.sign(slb)
  const lab = (r: unknown) => (r as { label: string }).label
  const fmt = (x: number, t: string) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toPrecision(3)} ${t}` : '—'
  const tag = (v: VariableMeta) => {
    const st = (v as MissionVariable).source_type
    return st === 'mission' ? 'satellite' : st === 'station' ? 'weather station' : 'model'
  }

  return (
    <div style={{ marginTop: 14 }}>
      <h3>⚖ {pair.a.v.short_name} vs {pair.b.v.short_name} — {regionName}</h3>
      <div ref={ref} className="chart" />
      <div className="row" style={{ marginTop: 8, gap: 16, flexWrap: 'wrap' }}>
        <span className="mono" style={{ color: COLORS[0] }}>
          {pair.a.v.short_name} ({tag(pair.a.v)}): <b>{fmt(sla, pair.a.v.trend_units)}</b> · {describe(lab(ra))}
        </span>
        <span className="mono" style={{ color: COLORS[1] }}>
          {pair.b.v.short_name} ({tag(pair.b.v)}): <b>{fmt(slb, pair.b.v.trend_units)}</b> · {describe(lab(rb))}
        </span>
      </div>
      {!both ? (
        <p className="muted small" style={{ marginBottom: 0 }}>
          One of the two records is too short in this window to compare trends.
        </p>
      ) : !agree ? (
        <div className="divergebox" style={{ marginTop: 10 }}>
          <b>The two records disagree in direction here.</b> They measure related but different
          things, and each has its own errors (resolution, retrieval gaps, model assumptions).
          Check which record is the observation and read each source's caution before trusting
          either trend on its own.
        </div>
      ) : (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Both records point the same way. That agreement is evidence, not proof: the sources
          are different products with different resolutions
          {sameUnits ? '' : ' and different units (two axes)'}.
        </p>
      )}
    </div>
  )
}

export default function CrossCheckPanel({ variable, allVars, regionId, regionName, presets, missions, cfg, windowStart, windowEnd }: {
  variable: VariableMeta
  allVars: VariableMeta[]
  regionId: string
  regionName: string
  presets: Presets
  missions: Missions | null
  cfg: AnalysisConfig
  windowStart: number
  windowEnd: number
}) {
  const pairs = useMemo(
    () => findCounterparts(variable, allVars, regionId, presets, missions),
    [variable, allVars, regionId, presets, missions])
  if (pairs.length === 0) return null
  return (
    <>
      {pairs.map((p) => (
        <PairView key={`${p.a.v.id}-${p.b.v.id}`} pair={p} regionName={regionName}
          cfg={cfg} start={windowStart} end={windowEnd} />
      ))}
    </>
  )
}
