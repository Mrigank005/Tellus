import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { loadCatalog, loadMissionVariables, type Catalog, type MissionVariable } from '../engine/loader'
import InvestigationWizard from './InvestigationWizard'

export default function ConfigureScreen() {
  const store = useStore()
  const [cat, setCat] = useState<Catalog | null>(null)
  const [missionVars, setMissionVars] = useState<MissionVariable[]>([])

  useEffect(() => {
    loadCatalog().then(setCat).catch((e) => console.error(e))
    loadMissionVariables().then(setMissionVars).catch(() => setMissionVars([]))
  }, [])

  if (!cat) return <div className="loading"><div className="spinner" /> Loading catalogue…</div>

  const allVars = [...cat.variables, ...missionVars]
  const variable = allVars.find((v) => v.id === store.variableId)!
  const windowMeta = cat.windows.find((w) => w.id === store.windowId)!
  const region = cat.regions.find((r) => r.id === store.regionId)

  return (
    <div className="container">
      <h2>{store.mode === 'place' ? 'Investigate a place' : 'Explore a variable'}</h2>
      <p className="sub">
        Choose what to measure, where, for how long, and at which time of year. Tellus
        computes everything live from the NASA-derived record.
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>1 · Environmental variable</h3>
        <div className="vargrid">
          {allVars.map((v) => (
            <div
              key={v.id}
              className={`varcard ${v.id === store.variableId ? 'sel' : ''}`}
              onClick={() => store.setVariable(v.id)}
            >
              <div className="vn">{v.short_name}{(v as MissionVariable).source_type === 'mission' ? ' ⚛' : ''}</div>
              <div className="vu">{v.units}</div>
              <div className="vq">{v.suitable_for}</div>
            </div>
          ))}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          <b style={{ color: 'var(--text)' }}>{variable.long_name}</b> — {variable.definition}
          {variable.monthly_units.startsWith('mm/day') &&
            ' Monthly rates are converted to true totals using each month’s day count.'}
        </p>
      </div>

      <div className="grid2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>2 · Region</h3>
          <div className="regionlist" style={{ maxHeight: 330, overflowY: 'auto', paddingRight: 4 }}>
            {cat.regions.map((r) => (
              <div
                key={r.id}
                className={`regionitem ${r.id === store.regionId ? 'sel' : ''}`}
                onClick={() => store.setRegion(r.id)}
              >
                <div className="rdot" />
                <div>
                  <div className="rname">{r.name}</div>
                  <div className="rdesc">{r.description}</div>
                </div>
              </div>
            ))}
            <div className="muted small" style={{ padding: '6px 2px' }}>
              …or draw your own region anywhere on Earth in the workspace — Tellus then
              fetches that area's NASA data live.
            </div>
          </div>
        </div>

        <div className="card">
          <h3>3 · Period &amp; season</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Analysis window</p>
          <div className="seg">
            {cat.windows.map((w) => (
              <button key={w.id} className={w.id === store.windowId ? 'on' : ''} onClick={() => store.setWindow(w.id)}>
                {w.label}
              </button>
            ))}
          </div>
          <p className="muted small" style={{ margin: '12px 0 0' }}>Time of year</p>
          <div className="seg">
            {Object.entries(cat.seasons).map(([id, s]) => (
              <button key={id} className={id === store.season ? 'on' : ''} onClick={() => store.setSeason(id)}>
                {s.label}
              </button>
            ))}
          </div>
          {cat.seasons[store.season].convention && (
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              {cat.seasons[store.season].convention}
            </p>
          )}
          <p className="muted small" style={{ margin: '12px 0 0' }}>
            Trend is reported per decade: <span className="mono" style={{ color: 'var(--accent-2)' }}>{variable.trend_units}</span>
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>4 · How the analysis works</h3>
        <div className="methodbox">
          <b>Trend magnitude:</b> Sen's slope (robust median of pairwise slopes) on real
          calendar years · <b>Significance:</b> Mann-Kendall test (tie- and
          continuity-corrected) at α = {cat.methods!.alpha}, plus an OLS t-test as a second
          opinion · <b>Map correction:</b> Benjamini–Hochberg FDR across every eligible grid
          cell of the map · <b>Uncertainty:</b> {Math.round(cat.methods!.confidence_level * 100)}% confidence interval on the slope.
          Series with under {cat.methods!.min_years} valid observations are labelled
          “insufficient data” — missing months are never treated as zero.
        </div>
        {variable.known_divergence && (
          <div className="cautionbox" style={{ marginTop: 10 }}>
            <b>Known model–observation divergence:</b> {variable.known_divergence}
          </div>
        )}
        {variable.caution && (
          <div className="cautionbox" style={{ marginTop: 10 }}>
            <b>Caution:</b> {variable.caution}
          </div>
        )}
      </div>

      <InvestigationWizard cat={cat} />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="muted small">
          {variable.short_name} · {region?.name ?? 'custom region'} · {windowMeta.label}
        </div>
        <button className="primary" onClick={() => store.go('workspace')}>
          Open the evidence workspace →
        </button>
      </div>
    </div>
  )
}
