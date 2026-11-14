import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { TOURS } from '../state/tours'

/**
 * S4 — guided, watchable demos. A tour is a list of captioned steps; each
 * step can drive the app's store so the user watches the investigation
 * unfold. Play/pause/next; Esc exits.
 */
export default function TourOverlay() {
  const tourId = useStore((s) => s.tourId)
  const setTour = useStore((s) => s.setTour)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  const timer = useRef<number | null>(null)

  const tour = tourId ? TOURS[tourId] : null

  useEffect(() => {
    if (!tour) return
    setStep(0)
    setPlaying(true)
    tour.steps[0]?.apply?.()
  }, [tourId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tour || !playing) return
    timer.current = window.setTimeout(() => {
      if (step < tour.steps.length - 1) {
        setStep(step + 1)
        tour.steps[step + 1]?.apply?.()
      } else {
        setPlaying(false)
      }
    }, 6000)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
  }, [tour, step, playing])

  if (!tour) return null
  const isLast = step >= tour.steps.length - 1

  function go(next: number) {
    const clamped = Math.max(0, Math.min(tour!.steps.length - 1, next))
    setStep(clamped)
    setPlaying(false)
    tour!.steps[clamped]?.apply?.()
  }

  return (
    <div
      className="no-print"
      style={{
        position: 'fixed', left: '50%', transform: 'translateX(-50%)',
        bottom: 22, zIndex: 100, width: 'min(680px, calc(100vw - 32px))',
        background: 'rgba(14,21,36,0.97)', border: '1px solid var(--accent)',
        borderRadius: 14, padding: '14px 18px', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      }}
      role="dialog"
      onKeyDown={(e) => { if (e.key === 'Escape') setTour(null) }}
      tabIndex={-1}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <b style={{ color: 'var(--accent-2)' }}>▶ {tour.title}</b>
        <span className="muted small">step {step + 1}/{tour.steps.length}</span>
      </div>
      <p style={{ margin: '8px 0 10px' }}>{tour.steps[step].caption}</p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="ghost" onClick={() => go(step - 1)} disabled={step === 0}>←</button>
          {!playing && !isLast && (
            <button className="ghost" onClick={() => setPlaying(true)}>▶ Play</button>
          )}
          {playing && <button className="ghost" onClick={() => setPlaying(false)}>❚❚ Pause</button>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {isLast ? (
            <button className="primary" onClick={() => setTour(null)}>Done — my turn</button>
          ) : (
            <button className="ghost" onClick={() => go(step + 1)}>Next →</button>
          )}
          <button className="ghost" onClick={() => setTour(null)}>Exit</button>
        </div>
      </div>
    </div>
  )
}
