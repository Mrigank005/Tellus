import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { askCopilot, type CopilotClaim, type CopilotResponse } from '../engine/copilot'
import { layaAnswer } from '../laya/router'
import { loadCatalog } from '../engine/loader'
import { useStore } from '../state/store'
import { Icon, type IconName } from './Icon'

const EXAMPLES = [
  'Is the Arctic warming faster than the tropics?',
  'Is monsoon rain changing in the Western Ghats?',
  'What is a Sen slope?',
]

const CONFIDENCE: Record<string, { label: string; stamp: string; icon: IconName | null }> = {
  supported: { label: 'Backed by evidence', stamp: 'pass', icon: 'check' },
  'needs-context': { label: 'Needs more detail', stamp: 'partial', icon: 'tilde' },
  abstain: { label: 'Cannot answer from the data', stamp: 'na', icon: null },
  unavailable: { label: 'Not available right now', stamp: 'na', icon: null },
  'laya-fallback': { label: 'Answered offline', stamp: 'none', icon: 'tilde' },
}

const EVIDENCE: Record<CopilotClaim['evidenceType'], { label: string; icon: IconName }> = {
  computed_result: { label: 'Computed by Tellus', icon: 'rings' },
  project_source: { label: 'Tellus method notes', icon: 'book' },
  external_source: { label: 'Outside source', icon: 'sat' },
}

export default function CopilotPanel() {
  const selection = useStore()
  const [question, setQuestion] = useState('')
  const [reply, setReply] = useState<CopilotResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldId = useId()
  const headId = useId()
  const area = useRef<HTMLTextAreaElement>(null)

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
        let action: CopilotResponse['action'] = null
        if (a.kind === 'recommend' && a.variableId) {
          const next = {
            variableId: a.variableId,
            season: a.season ?? selection.season,
            regionId: a.regionId ?? selection.regionId,
          }
          useStore.setState({ ...next, customPolygon: null })
          action = { ...next, windowId: selection.windowId }
        }
        setReply({
          kind: a.kind,
          message: a.text.replace(/\*\*/g, ''),
          claims: [],
          action,
          limitations: ['Offline mode: answered by Laya, the transparent rules engine (no AI service reachable).'],
          confidence: 'laya-fallback',
        } as unknown as CopilotResponse)
      } catch {
        setError('Neither the copilot nor Laya could answer. Check your connection and try again.')
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

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void ask()
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void ask()
    }
  }

  const tag = reply ? CONFIDENCE[reply.confidence] ?? CONFIDENCE.supported : null

  return (
    <section className="ask-card" aria-labelledby={headId}>
      <h3 id={headId}>Ask Tellus</h3>
      <p className="ask-sub">
        Ask about a place or a measurement. Tellus answers from the numbers on screen and shows
        the evidence it used.
      </p>

      <form onSubmit={onSubmit}>
        <label className="sr" htmlFor={fieldId}>Your question</label>
        <textarea
          id={fieldId}
          ref={area}
          rows={3}
          placeholder="Is monsoon rain changing in Kerala?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <div className="examples" role="group" aria-label="Example questions">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={busy}
              onClick={() => { setQuestion(ex); area.current?.focus() }}
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="ask-actions">
          <button type="submit" className="btn" disabled={busy || !question.trim()}>
            {busy ? 'Reading the evidence' : 'Ask'} <Icon name="arrow" className="arrow" />
          </button>
          <span className="note">Answers cite their evidence.</span>
        </div>
      </form>

      <div className="ask-out" aria-live="polite">
        {busy && (
          <div className="ask-busy" role="status">
            <div className="spinner" />
            <p>
              Reading the evidence. A written answer can take up to about 20 seconds, so thank you for waiting.
            </p>
          </div>
        )}

        {error && !busy && <p className="cautionbox" role="alert">{error}</p>}

        {reply && !busy && tag && (
          <div className="ask-reply">
            <div className="ask-reply-head">
              <b>Tellus says</b>
              <span className={`stamp ${tag.stamp}`}>
                {tag.icon && <Icon name={tag.icon} />}
                {tag.label}
              </span>
            </div>
            <p className="ask-msg">{reply.message}</p>

            {reply.limitations.length > 0 && (
              <ul className="ask-notes">
                {reply.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
              </ul>
            )}

            {reply.claims.length > 0 && (
              <div className="ask-evidence">
                <h4>Evidence</h4>
                <ul>
                  {reply.claims.map((claim, i) => {
                    const ev = EVIDENCE[claim.evidenceType] ?? EVIDENCE.computed_result
                    return (
                      <li key={`${claim.evidenceType}:${claim.evidenceId}:${i}`}>
                        <p>{claim.text}</p>
                        {claim.sourceUrl ? (
                          <a className="source" href={claim.sourceUrl} target="_blank" rel="noreferrer">
                            <Icon name={ev.icon} />{ev.label}
                          </a>
                        ) : (
                          <span className="source"><Icon name={ev.icon} />{ev.label}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {reply.action && (
              <button type="button" className="btn sm" onClick={applyAction}>
                Open this in the field desk <Icon name="arrow" className="arrow" />
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
