import { useEffect, useId, useMemo, useState } from 'react'
import recs from '../config/recommendations.json'
import { useStore } from '../state/store'
import { loadMissionVariables, type Catalog, type RegionMeta, type VariableMeta } from '../engine/loader'
import { Icon } from './Icon'
import { varIcon } from './VariableLibrary'

/**
 * A searchable, scrollable list of regions with their descriptions.
 * Shared by the question setup page and the wizard below it.
 */
export function RegionList({
  regions, selectedId, onPick, height = 340,
}: { regions: RegionMeta[]; selectedId: string; onPick: (id: string) => void; height?: number }) {
  const [q, setQ] = useState('')
  const inputId = useId()
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return regions
    return regions.filter((r) => r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle))
  }, [regions, q])

  return (
    <div className="cfg-regionbox">
      <label className="sr" htmlFor={inputId}>Search regions</label>
      <input
        id={inputId}
        type="search"
        className="cfg-search"
        placeholder="Search regions, e.g. Arctic or monsoon"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      <ul className="cfg-regions" style={{ maxHeight: height }}>
        {shown.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="cfg-region"
              aria-pressed={r.id === selectedId}
              onClick={() => onPick(r.id)}
            >
              <span className="dot" aria-hidden="true" />
              <span>
                <b>{r.name}</b>
                <span className="desc">{r.description}</span>
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="cfg-empty">No region matches “{q}”. Try a shorter word.</li>}
      </ul>
    </div>
  )
}

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
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const labels = ['Where', 'What kind of place', 'What worries you']
  const heading = [
    'Which region are you curious about?',
    'What kind of place is it?',
    'What worries you most?',
    'Here is what we would measure, and why',
  ][step]

  return (
    <section className="cfg-wiz" aria-labelledby="wiz-title">
      <div className="cfg-wiz-head">
        <h2 id="wiz-title" className="cfg-h">Not sure where to start?</h2>
        <p className="cfg-sub">
          Answer three questions and we will suggest what to measure. Every suggestion comes with
          its reason, and nothing is ranked by p-values.
        </p>
      </div>

      <ol className="wiz-steps" aria-label="Progress">
        {labels.map((label, i) => (
          <li
            key={label}
            className={step > i ? 'done' : step === i ? 'now' : undefined}
            aria-current={step === i ? 'step' : undefined}
          >
            <span className="n mono">{step > i ? <Icon name="check" /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <h3 className="wiz-q">{heading}</h3>

      {step === 0 && (
        <div>
          <RegionList
            regions={cat.regions}
            selectedId={store.regionId}
            height={260}
            onPick={(id) => { store.setRegion(id); setStep(1) }}
          />
          <p className="note" style={{ margin: '10px 0 0' }}>
            Or skip ahead: you can draw your own region in the field desk.
          </p>
        </div>
      )}

      {step === 1 && (
        <div className="wiz-choices">
          {recs.place_types.map((p) => (
            <button key={p.id} type="button" aria-pressed={placeType === p.id}
              onClick={() => { setPlaceType(p.id); setStep(2) }}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="wiz-choices">
          {recs.concerns.map((c) => (
            <button key={c.id} type="button" aria-pressed={concern === c.id}
              onClick={() => { setConcern(c.id); setStep(3) }}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      {step === 3 && (
        <div>
          <ol className="wiz-recs">
            {recommendations.map((r, i) => (
              <li key={r.variableId}>
                <span className="rank mono" aria-hidden="true">{i + 1}</span>
                <div className="body">
                  <div className="name">
                    <Icon name={varIcon(r.variableId)} />
                    <b>{r.v.short_name}</b>
                    <span className="mono units">{r.v.units}</span>
                  </div>
                  <p>{r.reason}</p>
                </div>
                <button type="button" className="btn sm" onClick={() => start(r.variableId)}>
                  Measure this <Icon name="arrow" className="arrow" />
                </button>
              </li>
            ))}
          </ol>
          {note && <div className="cautionbox" style={{ marginTop: 14 }}>{note}</div>}
        </div>
      )}

      {step > 0 && (
        <div className="wiz-nav">
          {step < 3 && (
            <button type="button" className="btn ghost sm" onClick={() => setStep(step - 1)}>
              <Icon name="arrow" className="flip" /> Back
            </button>
          )}
          {step === 3 && (
            <button type="button" className="btn ghost sm" onClick={() => { setStep(0); setPlaceType(null); setConcern(null) }}>
              Start over
            </button>
          )}
        </div>
      )}
    </section>
  )
}
