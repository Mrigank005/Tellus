import { useEffect, useState } from 'react'
import { loadAnomalies, type AnomalyResult } from '../engine/anomalies'

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
    loadAnomalies(variableId, regionId, season, windowId)
      .then((value) => { if (!cancelled) setResult(value) })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Diagnostics unavailable.') })
    return () => { cancelled = true }
  }, [variableId, regionId, season, windowId])

  return (
    <div className="card">
      <h3>Exploratory event diagnostics</h3>
      <p className="muted small">
        Candidate anomalies and mean shifts for investigation only. They do not replace the
        authoritative statistical trend verdict.
      </p>
      {error && <p className="cautionbox">{error}</p>}
      {result && (
        <>
          <p className="small">
            <b>{result.anomalies.length}</b> isolated event(s), <b>{result.changePoints.length}</b> mean-shift candidate(s)
          </p>
          {result.anomalies.slice(0, 5).map((event) => (
            <div className="muted small" key={`anomaly-${event.year}`}>
              {event.year}: {event.kind} event (score {event.score.toFixed(2)})
            </div>
          ))}
          {result.changePoints.slice(0, 3).map((point) => (
            <div className="muted small" key={`shift-${point.year}`}>
              Around {point.year}: {point.kind} (score {point.score.toFixed(2)})
            </div>
          ))}
        </>
      )}
    </div>
  )
}
