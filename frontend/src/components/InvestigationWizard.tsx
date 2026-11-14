import { useEffect, useMemo, useState } from 'react'
import recs from '../config/recommendations.json'
import { useStore } from '../state/store'
import { loadMissionVariables, type Catalog, type VariableMeta } from '../engine/loader'

/**
 * S3 — the question flow. Three questions (where, what kind of place, what
 * worries you) leading to a ranked, explained variable shortlist. This is the
 * challenge statement's "Approach" paragraph, built literally.
 */
export default function InvestigationWizard({ cat }: { cat: Catalog }) {
  const store = useStore()
  const [step, setStep] = useState(0)
  const [placeType, setPlaceType] = useState<string | null>(null)
  const [concern, setConcern] = useState<string | null>(null)
  const [missionVars, setMissionVars] = useState<VariableMeta[]>([])
  useEffect(() => {
    loadMissionVariables().then((v) => setMissionVars(v as VariableMeta[])).catch(() => setMissionVars([]))
  }, [])
  const allVars = useMemo(() => [...cat.variables, ...missionVars], [cat.variables, missionVars])

  const recommendations = useMemo(() => {
    if (!placeType || !concern) return []
    const m = (recs.matrix as Record<string, Record<string, { variableId: string; reason: string }[]>>)[concern]
    if (!m) return []
    const list = m[placeType] ?? m.default ?? []
    return list
      .map((r) => ({ ...r, v: allVars.find((v) => v.id === r.variableId) as VariableMeta }))
      .filter((r) => r.v)
  }, [placeType, concern, allVars])

  const note = concern ? (recs.notes as Record<string, string>)[concern] : undefined

  function start(variableId: string) {
    useStore.setState({
      variableId,
      customPolygon: null,
      compareRegionId: null,
      mode: 'place',
    })
    store.go('configure')
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>🧭 Not sure where to start? Answer three questions</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        The wizard maps your curiosity onto Tellus's variables — every
        recommendation comes with the reason, and nothing is ranked by
        p-values.
      </p>

      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {['Where', 'What kind of place', 'What worries you'].map((label, i) => (
          <span key={label} className={`pill ${step > i ? 'pill-none' : step === i ? 'pill-caution' : 'pill-insufficient'}`}>
            {i + 1}. {label}
          </span>
        ))}
      </div>

      {step === 0 && (
        <div>
          <div className="regionlist" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {cat.regions.map((r) => (
              <div key={r.id}
                className={`regionitem ${store.regionId === r.id ? 'sel' : ''}`}
                onClick={() => { store.setRegion(r.id); setStep(1) }}>
                <div className="rdot" />
                <div>
                  <div className="rname">{r.name}</div>
                  <div className="rdesc">{r.description}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            …or skip ahead and draw your own region later in the workspace.
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="row">
          {recs.place_types.map((p) => (
            <button key={p.id} className={`ghost ${placeType === p.id ? 'on' : ''}`}
              onClick={() => { setPlaceType(p.id); setStep(2) }}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="row">
          {recs.concerns.map((c) => (
            <button key={c.id} className={`ghost ${concern === c.id ? 'on' : ''}`}
              onClick={() => { setConcern(c.id); setStep(3) }}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="vargrid">
            {recommendations.map((r, i) => (
              <div key={r.variableId} className="varcard" onClick={() => start(r.variableId)}>
                <div className="vn">{i + 1}. {r.v.short_name}</div>
                <div className="vu">{r.v.units}</div>
                <div className="vq">{r.reason}</div>
              </div>
            ))}
          </div>
          {note && <div className="cautionbox" style={{ marginTop: 10 }}>{note}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="ghost" onClick={() => { setStep(0); setPlaceType(null); setConcern(null) }}>
              ↺ Start over
            </button>
          </div>
        </div>
      )}

      {step > 0 && step < 3 && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={() => setStep(step - 1)}>← Back</button>
        </div>
      )}
    </div>
  )
}
