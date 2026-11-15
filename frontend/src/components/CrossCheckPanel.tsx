import { useMemo } from 'react'
import type { MissionVariable, Missions, Presets, VariableMeta } from '../engine/loader'
import type { AnalysisConfig } from '../engine/analysis'
import { summarize, type Summarized } from '../engine/stats'
import { useChart } from '../hooks/useChart'
import ChartLegend from './ChartLegend'
import { useTheme } from '../state/theme'
import { chartBase } from '../styles/tokens'
import { Icon, type IconName } from './Icon'

/** Model-versus-satellite (or second-model, or station) cross-check for any
 * pair of variables declared as counterparts in config/missions.json
 * (`counters`). Both series are analysed with the same persistence-adjusted
 * engine over the same window; disagreement is shown, never hidden. */

type Entry = { years: number[]; values: (number | null)[] }
type Side = { v: VariableMeta; entry: Entry }
type Pair = { a: Side; b: Side }


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

  const theme = useTheme((s) => s.theme)
  const sameUnits = pair.a.v.units === pair.b.v.units
  // first variable = ink line with round dots; its counterpart = leaf line with diamond dots
  const option = useMemo(() => {
    const base = chartBase(theme)
    const t = base.t
    const colors = [t.ink, t.leaf]
    const mk = (s: Side, ser: { years: number[]; values: number[] }, color: string, axis: number, shape: string) => ({
      name: s.v.short_name, type: 'line', symbol: shape, symbolSize: 5, yAxisIndex: axis,
      data: ser.years.map((y, i) => [y, Number.isFinite(ser.values[i]) ? +ser.values[i].toPrecision(5) : null]),
      lineStyle: { width: 1.6, color },
      itemStyle: { color: t.paperRaised, borderColor: color, borderWidth: 1.5 },
    })
    const axis = (name: string, color: string, split: boolean) => ({
      type: 'value', scale: true, ...base.axis, name, nameTextStyle: { ...base.axis.nameTextStyle, color, align: 'left' },
      splitLine: split ? base.axis.splitLine : { show: false },
    })
    return {
      backgroundColor: base.backgroundColor,
      textStyle: base.textStyle,
      grid: { left: 62, right: sameUnits ? 18 : 62, top: 30, bottom: 34 },
      tooltip: {
        ...base.tooltip, trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.copper, type: 'dashed', width: 1 } },
      },
      xAxis: { type: 'value', min: start, max: end, ...base.axis, name: '', axisLabel: { ...base.axis.axisLabel, formatter: (v: number) => String(v), hideOverlap: true }, },
      yAxis: sameUnits ? [axis(pair.a.v.units, t.inkFaint, true)]
        : [axis(pair.a.v.units, t.ink, true), { ...axis(pair.b.v.units, t.leaf, false), nameTextStyle: { ...base.axis.nameTextStyle, color: t.leaf, align: 'right' } }],
      series: [mk(pair.a, sa, colors[0], 0, 'circle'), mk(pair.b, sb, colors[1], sameUnits ? 0 : 1, 'diamond')],
    }
  }, [pair, sa, sb, sameUnits, start, end, theme])
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
  const badgeIcon = (v: VariableMeta): IconName => {
    const st = (v as MissionVariable).source_type
    return st === 'mission' ? 'sat' : st === 'station' ? 'pin' : 'rings'
  }
  const badgeText = (v: VariableMeta) => (v as MissionVariable).instrument ?? 'NASA POWER · MERRA-2'
  const stampOf = (label: string) => label === 'detected-increase' ? { c: 'up', t: 'Detected increase' }
    : label === 'detected-decrease' ? { c: 'down', t: 'Detected decrease' }
    : label === 'no-detected-trend' ? { c: 'none', t: 'No clear trend' }
    : { c: 'na', t: 'Too little data' }
  const dir = (x: number) => (Number.isFinite(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : '') : '')
  const row = (v: VariableMeta, slope: number, r: unknown, cls: string) => {
    const st = stampOf(lab(r))
    return (
      <div className="xrow" role="listitem">
        <span className={`xsw ${cls}`} aria-hidden="true" />
        <span className="xkey">{v.short_name}<small>{tag(v)}, trend per decade</small></span>
        <span className={`xval ${dir(slope)}`}>{fmt(slope, v.trend_units)}</span>
        <span className={`stamp ${st.c}`}>{st.t}</span>
      </div>
    )
  }

  return (
    <section className="xpanel">
      <div className="xpanel-head">
        <h3>{pair.a.v.short_name} vs {pair.b.v.short_name}: {regionName}</h3>
        <div className="xpanel-sources">
          <span className="source"><Icon name={badgeIcon(pair.a.v)} />{badgeText(pair.a.v)}</span>
          <span className="source"><Icon name={badgeIcon(pair.b.v)} />{badgeText(pair.b.v)}</span>
        </div>
      </div>
      <ChartLegend items={[
        { label: pair.a.v.short_name, color: 'var(--ink)', line: 'solid', dot: 'circle' },
        { label: pair.b.v.short_name, color: 'var(--leaf)', line: 'solid', dot: 'diamond' },
      ]} />
      <div ref={ref} className="chart" role="img"
        aria-label={`${pair.a.v.short_name} and ${pair.b.v.short_name} for ${regionName}, ${start} to ${end}.`} />
      <div className="xledger" role="list">
        {row(pair.a.v, sla, ra, 'ink')}
        {row(pair.b.v, slb, rb, 'leaf diamond')}
      </div>
      {!both ? (
        <p className="muted small note-line">
          One of the two records is too short in this window to compare trends.
        </p>
      ) : !agree ? (
        <div className="verdict">
          <span className="stamp partial"><Icon name="x" />Disagree in direction</span>
          <div className="divergebox">
            <b>The two records disagree in direction here.</b> They measure related but different
            things, and each has its own errors (resolution, retrieval gaps, model assumptions).
            Check which record is the observation and read each source's caution before trusting
            either trend on its own.
          </div>
        </div>
      ) : (
        <div className="verdict">
          <span className="stamp pass"><Icon name="check" />Agree in direction</span>
          <p className="muted small">
            Both records point the same way. That agreement is evidence, not proof: the sources
            are different products with different resolutions
            {sameUnits ? '' : ' and different units (two axes)'}.
          </p>
        </div>
      )}
    </section>
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
