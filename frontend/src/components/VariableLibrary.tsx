import { useEffect, useState } from 'react'
import { loadCatalog, loadMissionVariables, type Catalog, type MissionVariable, type VariableMeta } from '../engine/loader'
import { useStore } from '../state/store'
import { Icon, type IconName } from './Icon'

/** An authored icon per variable (anything from another record gets the satellite). */
export function varIcon(id: string): IconName {
  switch (id) {
    case 'T2M': case 'T2M_MAX': return 'thermo'
    case 'T2M_MIN': return 'moon'
    case 'PRECTOTCORR': case 'RH2M': return 'drop'
    case 'WS10M': return 'wind'
    case 'GWETTOP': return 'sprout'
    case 'EVLAND': return 'leaf'
    default: return 'sat'
  }
}

/** "GPM IMERG (satellite constellation + gauges)" -> "GPM IMERG" */
export function shortSource(instrument: string): string {
  return instrument.split(' (')[0]
}

/** Distinct caveats for one variable, in plain order. */
function caveatsOf(v: VariableMeta): string[] {
  const out: string[] = []
  for (const t of [v.caution, v.known_divergence, v.caveat]) {
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function isMission(v: VariableMeta): v is MissionVariable {
  return Boolean((v as MissionVariable).instrument)
}

function CoreEntry({ v, onInvestigate }: { v: VariableMeta; onInvestigate: () => void }) {
  const caveats = caveatsOf(v)
  return (
    <article className="lib-entry">
      <div className="lib-label">
        <Icon name="pin" className="pin" />
        <Icon name={varIcon(v.id)} className="glyph" />
        <h3>{v.short_name}</h3>
        <div className="mono lib-units">{v.units}</div>
        <div className="lib-trend">Trend reported in <span className="mono">{v.trend_units}</span></div>
      </div>
      <div className="lib-text">
        <p className="lib-def"><b>{v.long_name}.</b> {v.definition}</p>
        <dl className="lib-facts">
          <dt>Good for</dt>
          <dd>{v.suitable_for}</dd>
          <dt>Higher values mean</dt>
          <dd>{v.higher_means}</dd>
          <dt>How totals are made</dt>
          <dd>
            {v.aggregation === 'sum'
              ? 'Monthly mm/day rates become true totals, using each month’s day count.'
              : 'Day-count-weighted means of the monthly values.'}
          </dd>
        </dl>
        {caveats.map((c) => (
          <p key={c} className="lib-caveat"><b>Keep in mind:</b> {c}</p>
        ))}
        <div className="lib-actions">
          <button type="button" className="btn sm" onClick={onInvestigate}>
            Investigate this <Icon name="arrow" className="arrow" />
          </button>
          <span className="source"><Icon name="sat" />NASA POWER · MERRA-2</span>
        </div>
      </div>
    </article>
  )
}

function OtherEntry({ v, onInvestigate }: { v: MissionVariable; onInvestigate: () => void }) {
  const caveats = caveatsOf(v)
  return (
    <article className="lib-other">
      <div className="lib-other-a">
      <header>
        <h3>{v.short_name}</h3>
        <span className="mono lib-units">{v.units}</span>
      </header>
      <p className="lib-def">{v.definition}</p>
      <p className="lib-good"><b>Good for:</b> {v.suitable_for}</p>
      </div>
      <div className="lib-other-b">
      <p className="lib-src">
        <span className="source"><Icon name="sat" />{shortSource(v.instrument)}</span>
        <span className="note">{v.source}</span>
      </p>
      {caveats.map((c) => (
        <p key={c} className="lib-caveat"><b>Keep in mind:</b> {c}</p>
      ))}
      <button type="button" className="btn ghost sm" onClick={onInvestigate}>
        Investigate this <Icon name="arrow" className="arrow" />
      </button>
      </div>
    </article>
  )
}

/** The “multitude of variables” problem, answered with a readable field guide. */
export default function VariableLibrary() {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [missionVars, setMissionVars] = useState<MissionVariable[]>([])
  const store = useStore()

  useEffect(() => {
    loadCatalog().then(setCat).catch(console.error)
    loadMissionVariables().then(setMissionVars).catch(() => setMissionVars([]))
  }, [])

  if (!cat) return <div className="loading"><div className="spinner" /> Loading…</div>

  function investigate(id: string) {
    store.setVariable(id)
    store.go('configure')
  }

  return (
    <div className="lib wrap">
      <header className="lib-head">
        <h1 className="title">What we measure</h1>
        <p className="lede">
          NASA missions and models measure thousands of quantities. Tellus curates the {cat.variables.length} core
          ones below, each readable anywhere on Earth from 1981 to 2025, and {missionVars.length} more from other
          records. Every one comes with a plain-language definition, so you can decide what deserves investigation.
        </p>
      </header>

      <section className="lib-core" aria-labelledby="lib-core-h">
        <h2 id="lib-core-h" className="lib-h">The core {cat.variables.length}, worldwide</h2>
        <div className="lib-entries">
          {cat.variables.map((v) => (
            <CoreEntry key={v.id} v={v} onInvestigate={() => investigate(v.id)} />
          ))}
        </div>
      </section>

      {missionVars.length > 0 && (
        <section className="lib-more" aria-labelledby="lib-more-h">
          <h2 id="lib-more-h" className="lib-h">Other records we can read</h2>
          <p className="lib-more-lede">
            Satellites, land models and weather stations that let you check the core record against an
            independent source. Their regions and years of coverage are narrower, and each says where it comes from.
          </p>
          <div className="lib-others">
            {missionVars.map((v) => (
              <OtherEntry key={v.id} v={v} onInvestigate={() => investigate(v.id)} />
            ))}
          </div>
        </section>
      )}

      <aside className="lib-origin">
        <h2 className="lib-h">Where the data comes from</h2>
        <p>
          The core variables are served by NASA’s POWER project (Langley Research Center), derived
          from the MERRA-2 reanalysis, a NASA global model constrained by decades of
          satellite observations, at its native 0.5° × 0.625° grid across the entire planet
          (208,297 cells). Precipitation is additionally cross-checked against the observed
          GPCP V2.3 satellite–gauge record. The challenge statement names MERRA-2 among the
          recommended model sources.
        </p>
      </aside>
    </div>
  )
}
