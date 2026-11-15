import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { place, seasonPhrase, spanPhrase } from '../state/places'
import { loadCatalog, loadMissionVariables, type Catalog, type MissionVariable } from '../engine/loader'
import InvestigationWizard, { RegionList } from './InvestigationWizard'
import { Icon } from './Icon'
import { shortSource, varIcon } from './VariableLibrary'

/** Move to a section and put keyboard focus on the current choice inside it. */
function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  const target = el.querySelector<HTMLElement>('[aria-pressed="true"]') ?? el.querySelector<HTMLElement>('button, input')
  window.setTimeout(() => target?.focus({ preventScroll: true }), reduce ? 0 : 350)
}

function SentenceChip({ to, children }: { to: string; children: string }) {
  return (
    <button type="button" className="chip" onClick={() => jump(to)}>
      <span>{children}</span>
      <Icon name="chev" />
    </button>
  )
}

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
  const season = cat.seasons[store.season]
  const mission = (variable as MissionVariable).instrument ? (variable as MissionVariable) : null

  const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)
  const windowPhrase = spanPhrase(windowMeta)
  const seasonText = seasonPhrase(store.season, season?.label)
  const regionName = place(store.regionId, region?.name).mid

  return (
    <div className="cfg wrap">
      <header className="cfg-head">
        <h1 className="title">Set up your question</h1>
        <p className="lede">
          Finish the sentence below, or scroll for the detail behind each choice. Tellus computes
          everything live from the NASA-derived record.
        </p>

        <p className="cfg-sentence">
          Is <SentenceChip to="cfg-variable">{lower(variable.short_name)}</SentenceChip> changing in{' '}
          <SentenceChip to="cfg-region">{regionName}</SentenceChip> over{' '}
          <SentenceChip to="cfg-when">{windowPhrase}</SentenceChip>{' '}
          <span className="nowrap"><SentenceChip to="cfg-when">{seasonText}</SentenceChip>?</span>
        </p>

        <div className="cfg-go">
          <button type="button" className="btn" onClick={() => store.go('workspace')}>
            Read the answer <Icon name="arrow" className="arrow" />
          </button>
          <span className="note">Each chip jumps to its choices below.</span>
        </div>
      </header>

      <section className="cfg-sec" id="cfg-variable" aria-labelledby="cfg-variable-h">
        <h2 id="cfg-variable-h" className="cfg-h">What to measure</h2>
        <p className="cfg-sub">
          Pick one quantity. The first {cat.variables.length} are the core record, readable anywhere on Earth.
          {missionVars.length > 0 && ' The rest come from other satellites, models and stations, and carry a source tag.'}
        </p>
        <div className="cfg-vars">
          <ul className="cfg-varlist" aria-label="Variables">
            {allVars.map((v) => {
              const m = (v as MissionVariable).instrument
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    className="cfg-var"
                    aria-pressed={v.id === store.variableId}
                    onClick={() => store.setVariable(v.id)}
                  >
                    <Icon name={varIcon(v.id)} className="glyph" />
                    <span className="main">
                      <span className="line"><b>{v.short_name}</b><span className="mono units">{v.units}</span></span>
                      <span className="sub">{v.suitable_for}</span>
                    </span>
                    {m && <span className="source"><Icon name="sat" />{shortSource(m)}</span>}
                  </button>
                </li>
              )
            })}
          </ul>

          <aside className="cfg-specimen" aria-label={`About ${variable.short_name}`}>
            <Icon name="pin" className="pin" />
            <h3>{variable.short_name}</h3>
            <div className="what">{variable.long_name} <span className="mono">· {variable.units}</span></div>
            <p className="def">
              {variable.definition}
              {variable.monthly_units.startsWith('mm/day') &&
                ' Monthly rates are converted to true totals using each month’s day count.'}
            </p>
            <dl className="facts">
              <dt>Good for</dt><dd>{variable.suitable_for}</dd>
              <dt>Trend per decade</dt><dd className="mono">{variable.trend_units}</dd>
              <dt>Higher means</dt><dd>{variable.higher_means}</dd>
            </dl>
            {mission && (
              <p className="src">
                <span className="source"><Icon name="sat" />{shortSource(mission.instrument)}</span>
                <span className="note">{mission.source}</span>
              </p>
            )}
          </aside>
        </div>
      </section>

      <div className="cfg-two">
        <section className="cfg-sec" id="cfg-region" aria-labelledby="cfg-region-h">
          <h2 id="cfg-region-h" className="cfg-h">Where</h2>
          <RegionList regions={cat.regions} selectedId={store.regionId} onPick={(id) => store.setRegion(id)} />
          <p className="note" style={{ margin: '10px 0 0' }}>
            Or draw your own region anywhere on Earth in the field desk. Tellus then fetches that area’s NASA data live.
          </p>
        </section>

        <section className="cfg-sec" id="cfg-when" aria-labelledby="cfg-when-h">
          <h2 id="cfg-when-h" className="cfg-h">How long, and when</h2>
          <div className="cfg-field" role="group" aria-labelledby="cfg-window-l">
            <div className="cfg-label" id="cfg-window-l">Analysis window</div>
            <div className="seg">
              {cat.windows.map((w) => (
                <button key={w.id} type="button" aria-pressed={w.id === store.windowId} onClick={() => store.setWindow(w.id)}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <div className="cfg-field" role="group" aria-labelledby="cfg-season-l">
            <div className="cfg-label" id="cfg-season-l">Time of year</div>
            <div className="seg">
              {Object.entries(cat.seasons).map(([id, s]) => (
                <button key={id} type="button" aria-pressed={id === store.season} onClick={() => store.setSeason(id)}>
                  {s.label}
                </button>
              ))}
            </div>
            {season.convention && <p className="note" style={{ margin: '8px 0 0' }}>{season.convention}</p>}
          </div>
          <p className="cfg-trend">
            Trend is reported per decade: <span className="mono">{variable.trend_units}</span>
          </p>
        </section>
      </div>

      <section className="cfg-sec" aria-labelledby="cfg-method-h">
        <h2 id="cfg-method-h" className="cfg-h">How the analysis works</h2>
        <div className="methodbox">
          <b>Trend magnitude:</b> Sen's slope (robust median of pairwise slopes) on real
          calendar years · <b>Significance:</b> Mann-Kendall test (tie- and
          continuity-corrected) at α = {cat.methods!.alpha}, plus an OLS t-test as a second
          opinion · <b>Map correction:</b> Benjamini–Hochberg FDR across every eligible grid
          cell of the map · <b>Uncertainty:</b> {Math.round(cat.methods!.confidence_level * 100)}% confidence interval on the slope.
          Series with under {cat.methods!.min_years} valid observations are labelled
          “insufficient data”. Missing months are never treated as zero.
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
      </section>

      <InvestigationWizard cat={cat} />

      <div className="cfg-foot">
        <p>
          <b>{variable.short_name}</b> in {regionName}, {windowMeta.label.toLowerCase()}
        </p>
        <button type="button" className="btn" onClick={() => store.go('workspace')}>
          Open in the field desk <Icon name="arrow" className="arrow" />
        </button>
      </div>
    </div>
  )
}
