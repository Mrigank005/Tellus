import { useState } from 'react'
import { DETECTIVE_CASES, useStore } from '../state/store'
import { TOURS } from '../state/tours'
import { layaAnswer } from '../laya/router'
import { loadCatalog } from '../engine/loader'
import CopilotPanel from './CopilotPanel'

export default function StartScreen() {
  const store = useStore()
  const [question, setQuestion] = useState('')
  const [reply, setReply] = useState<{ text: string; kind: string; go?: boolean } | null>(null)

  async function ask() {
    const cat = await loadCatalog()
    const a = layaAnswer(question, cat)
    const canGo = a.kind === 'recommend' && !!a.variableId
    setReply({ text: a.text, kind: a.kind, go: canGo })
    if (canGo) {
      // pre-select the recommended investigation
      useStore.setState({
        variableId: a.variableId!,
        season: a.season ?? store.season,
        regionId: a.regionId ?? store.regionId,
        customPolygon: null,
      })
    }
  }

  function openCase(c: (typeof DETECTIVE_CASES)[number]) {
    useStore.setState({
      variableId: c.variableId,
      season: c.season,
      windowId: c.windowId,
      regionId: c.regionId,
      compareRegionId: c.compareRegionId ?? null,
      customPolygon: null,
      mode: 'place',
    })
    store.go('workspace')
  }

  return (
    <div className="container">
      <div className="hero">
        <div className="kicker">NASA Earth science data · The whole Earth · 1981–2025</div>
        <h2 className="big">What is changing on Earth —<br />and is it really changing?</h2>
        <p className="lead">
          Earth's connected system is always moving. A measured variable can rise in one
          region and fall in another. Tellus turns you into a data detective: pick a
          place or a variable anywhere on the planet, see the map and the time series, and
          get the statistical verdict — what, where, how much, and whether it is{' '}
          <em>significant</em>.
        </p>
      </div>

      <div className="modecards">
        <div className="modecard" onClick={() => { store.setMode('place'); store.go('configure') }}>
          <div className="icon">📍</div>
          <h3>Investigate a place</h3>
          <p>Pick a region — the Himalaya, the Western Ghats, the Thar desert — and ask what is changing there.</p>
        </div>
        <div className="modecard" onClick={() => { store.setMode('variable'); store.go('configure') }}>
          <div className="icon">🌡️</div>
          <h3>Explore a variable</h3>
          <p>Start from temperature, rainfall, humidity… and discover where in the world it trends up, down, or nowhere.</p>
        </div>
      </div>

      <div className="card cases">
        <h3>🕵 Detective cases — guided demos</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Open a fully worked investigation in one click.
        </p>
        <div className="casegrid">
          {DETECTIVE_CASES.map((c) => (
            <div key={c.id} className="case" onClick={() => openCase(c)}>
              <div className="tag">Case file</div>
              {TOURS[c.id] && (
                <button className="ghost" style={{ position: 'absolute', top: 12, right: 12, padding: '4px 10px', fontSize: 12 }}
                  onClick={(e) => { e.stopPropagation(); openCase(c); useStore.setState({ tourId: c.id }); }}>
                  ▶ Watch
                </button>
              )}
              <h4>{c.title}</h4>
              <p><b>{c.question}</b></p>
              <p>{c.blurb}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>💬 Ask Laya</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Laya is Tellus's transparent rules-based guide — it maps your question onto a
          supported variable and region, and tells you when something is outside scope.
        </p>
        <div className="layabox">
          <input
            className="laya-input"
            placeholder="e.g. Is the Himalaya getting warmer? Is monsoon rainfall changing?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
          />
          <button className="primary" onClick={ask}>Ask</button>
        </div>
        {reply && (
          <div className="laya-reply">
            <div className="who">LAYA</div>
            <div dangerouslySetInnerHTML={{ __html: mdLite(reply.text) }} />
            {reply.go && (
              <button className="primary" style={{ marginTop: 10 }}
                onClick={() => store.go('workspace')}>
                Open this investigation →
              </button>
            )}
          </div>
        )}
      </div>

      <CopilotPanel />
    </div>
  )
}

/** tiny markdown: **bold** only */
function mdLite(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
}
