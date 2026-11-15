import { useEffect, useState } from 'react'
import { loadAnomalies, type AnomalyResult } from '../engine/anomalies'
import { Icon } from './Icon'

type Props = {
  variableId: string
  regionId: string
  season: string
  windowId: string
}

export default function AnomalyPanel({ variableId, regionId, season, windowId }: Props) {
  const [result, setResult] = useState<AnomalyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setResult(null)
    loadAnomalies(variableId, regionId, season, windowId)
      .then((value) => { if (!cancelled) setResult(value) })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Diagnostics unavailable.') })
    return () => { cancelled = true }
  }, [variableId, regionId, season, windowId])

  return (
    <div className="desk-anom">
      <div className="panel-head">
        <h3>Exploratory event diagnostics</h3>
        <span className="row">
          <span className="stamp partial"><Icon name="tilde" /><span>Exploratory</span></span>
          <span className="source"><Icon name="sat" />NASA POWER &middot; MERRA-2</span>
        </span>
      </div>
      <p className="note">
        Candidate anomalies and mean shifts for investigation only. They do not replace the
        authoritative statistical trend verdict.
      </p>
      {error && <p className="cautionbox" role="alert">{error}</p>}
      {!error && !result && <p className="note" role="status">Looking for events…</p>}
      {result && (
        <>
          <p className="anom-count">
            <b className="num">{result.anomalies.length}</b> isolated event{result.anomalies.length === 1 ? '' : 's'},{' '}
            <b className="num">{result.changePoints.length}</b> mean-shift candidate{result.changePoints.length === 1 ? '' : 's'}
          </p>
          {(result.anomalies.length > 0 || result.changePoints.length > 0) && (
            <ul className="ledger">
              {result.anomalies.slice(0, 5).map((event) => (
                <li className="ledger-row" key={`anomaly-${event.year}`}>
                  <span className="when num">{event.year}</span>
                  <span className="what">{event.kind} event</span>
                  <span className="score num">score {event.score.toFixed(2)}</span>
                </li>
              ))}
              {result.changePoints.slice(0, 3).map((point) => (
                <li className="ledger-row" key={`shift-${point.year}`}>
                  <span className="when num">~{point.year}</span>
                  <span className="what">{point.kind}</span>
                  <span className="score num">score {point.score.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
