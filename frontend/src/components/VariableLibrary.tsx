import { useEffect, useState } from 'react'
import { loadCatalog, loadMissionVariables, type Catalog, type MissionVariable } from '../engine/loader'
import { useStore } from '../state/store'

/** The “multitude of variables” problem, answered with a readable library. */
export default function VariableLibrary() {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [missionVars, setMissionVars] = useState<MissionVariable[]>([])
  const store = useStore()

  useEffect(() => {
    loadCatalog().then(setCat).catch(console.error)
    loadMissionVariables().then(setMissionVars).catch(() => setMissionVars([]))
  }, [])

  if (!cat) return <div className="loading"><div className="spinner" /> Loading…</div>

  return (
    <div className="container">
      <h2>Variable Library</h2>
      <p className="sub">
        NASA missions and models measure thousands of quantities. Tellus curates the
        eight below — every one is live-analysable worldwide, 1981–2025, with plain-language
        definitions so you can decide what deserves investigation.
      </p>
      <div className="libgrid">
        {[...cat.variables, ...missionVars].map((v) => (
          <div key={v.id} className="libcard">
            <div className="lh">
              <h3>{v.short_name}</h3>
              <span className="units">{v.units}</span>
            </div>
            <p><b style={{ color: 'var(--text)' }}>{v.long_name}</b> — {v.definition}</p>
            {(v as MissionVariable).instrument && (
              <p className="small" style={{ color: 'var(--good)' }}>
                ⚛ Instrument: {(v as MissionVariable).instrument} — {(v as MissionVariable).source}
              </p>
            )}
            <p className="small">
              <b style={{ color: 'var(--accent-2)' }}>Answers:</b> {v.suitable_for} ·
              trends reported in <span className="mono">{v.trend_units}</span>
              <br />
              <b style={{ color: 'var(--accent-2)' }}>Aggregation:</b>{' '}
              {v.aggregation === 'sum'
                ? 'monthly mm/day rates → true totals via per-month day counts'
                : 'day-count-weighted means'}
              <br />
              <b style={{ color: 'var(--accent-2)' }}>Higher values mean:</b> {v.higher_means}
            </p>
            {(v.caution || v.known_divergence) && (
              <p className="small" style={{ color: 'var(--warn)' }}>
                ⚠ {v.caution ?? v.known_divergence}
              </p>
            )}
            <button className="ghost" onClick={() => {
              store.setVariable(v.id)
              store.go('configure')
            }}>Investigate this variable →</button>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Where the data comes from</h3>
        <p className="muted small" style={{ marginBottom: 0 }}>
          All variables are served by NASA's POWER project (Langley Research Center), derived
          from the MERRA-2 reanalysis — a NASA global model constrained by decades of
          satellite observations — at its native 0.5° × 0.625° grid across the entire planet
          (208,297 cells). Precipitation is additionally cross-checked against the observed
          GPCP V2.3 satellite–gauge record. The challenge statement names MERRA-2 among the
          recommended model sources.
        </p>
      </div>
    </div>
  )
}
