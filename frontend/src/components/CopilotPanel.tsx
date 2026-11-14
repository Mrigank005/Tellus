import { useState } from 'react'
import { askCopilot, type CopilotResponse } from '../engine/copilot'
import { layaAnswer } from '../laya/router'
import { loadCatalog } from '../engine/loader'
import { useStore } from '../state/store'

export default function CopilotPanel() {
  const selection = useStore()
  const [question, setQuestion] = useState('')
  const [reply, setReply] = useState<CopilotResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ask() {
    if (!question.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setReply(await askCopilot(question.trim(), selection))
    } catch {
      // the app never depends on the AI backend: fall back to Laya, the
      // transparent rules engine, so the question still gets answered
      try {
        const cat = await loadCatalog()
        const a = layaAnswer(question.trim(), cat)
        if (a.kind === 'recommend' && a.variableId) {
          useStore.setState({
            variableId: a.variableId,
            season: a.season ?? selection.season,
            regionId: a.regionId ?? selection.regionId,
            customPolygon: null,
          })
        }
        setReply({
          kind: a.kind,
          message: a.text.replace(/\*\*/g, ''),
          claims: [],
          limitations: ['Offline mode: answered by Laya, the transparent rules engine (no AI service reachable).'],
          confidence: 'laya-fallback',
        } as unknown as CopilotResponse)
      } catch {
        setError('Neither the copilot nor Laya could answer. Check your connection.')
      }
    } finally {
      setBusy(false)
    }
  }

  function applyAction() {
    if (!reply?.action) return
    useStore.setState({
      variableId: reply.action.variableId,
      regionId: reply.action.regionId,
      season: reply.action.season,
      windowId: reply.action.windowId,
      customPolygon: null,
    })
    selection.go('workspace')
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>✨ Tellus Copilot</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Ask about a supported NASA Earth-science investigation. AI explanations are grounded in
        Tellus evidence; Laya remains available offline.
      </p>
      <div className="layabox">
        <input
          className="laya-input"
          placeholder="e.g. Compare warming in the Arctic and tropics"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          disabled={busy}
        />
        <button className="primary" onClick={ask} disabled={busy || !question.trim()}>
          {busy ? 'Thinking…' : 'Ask AI'}
        </button>
      </div>
      {error && <p className="cautionbox">{error}</p>}
      {reply && (
        <div className="laya-reply">
          <div className="who">TELLUS COPILOT · {reply.confidence}</div>
          <p>{reply.message}</p>
          {reply.limitations.map((limitation) => <p className="muted small" key={limitation}>Note: {limitation}</p>)}
          {reply.claims.length > 0 && (
            <div className="muted small">
              <b>Evidence</b>
              {reply.claims.map((claim, i) => (
                <div key={`${claim.evidenceType}:${claim.evidenceId}:${i}`}>
                  {claim.text} {claim.sourceUrl && <a href={claim.sourceUrl} target="_blank" rel="noreferrer">Source</a>}
                </div>
              ))}
            </div>
          )}
          {reply.action && (
            <button className="primary" style={{ marginTop: 10 }} onClick={applyAction}>
              Apply suggested investigation →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
