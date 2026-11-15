import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { TOURS, type TourStep } from '../state/tours'
import { Icon } from './Icon'

/** A tour step may name the part of the page it is talking about (a CSS selector). */
type Step = TourStep & { target?: string }

/** A leaf/sun ring drawn around the element a step points at. */
function TargetRing({ selector }: { selector?: string }) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  useEffect(() => {
    if (!selector) { setBox(null); return }
    let raf = 0
    let scrolled = false
    const measure = () => {
      const el = document.querySelector(selector)
      if (!el) { setBox(null); return }
      if (!scrolled) {
        scrolled = true
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
      }
      const r = el.getBoundingClientRect()
      setBox((b) => (b && b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height
        ? b : { top: r.top, left: r.left, width: r.width, height: r.height }))
    }
    const tick = () => { measure(); raf = window.requestAnimationFrame(tick) }
    tick()
    return () => window.cancelAnimationFrame(raf)
  }, [selector])

  if (!box) return null
  const pad = 6
  return (
    <div
      className="tour-ring no-print"
      aria-hidden="true"
      style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
    />
  )
}

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

  // Escape closes the tour from anywhere on the page
  useEffect(() => {
    if (!tour) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTour(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tour, setTour])

  if (!tour) return null
  const current = tour.steps[step] as Step
  const isLast = step >= tour.steps.length - 1

  function go(next: number) {
    const clamped = Math.max(0, Math.min(tour!.steps.length - 1, next))
    setStep(clamped)
    setPlaying(false)
    tour!.steps[clamped]?.apply?.()
  }

  const pct = ((step + 1) / tour.steps.length) * 100

  return (
    <>
      <TargetRing selector={current.target} />
      <div className="tour no-print" role="dialog" aria-label={`Guided tour: ${tour.title}`}>
        <div className="tour-head">
          <span className="tour-count mono" aria-label={`Step ${step + 1} of ${tour.steps.length}`}>
            {step + 1} / {tour.steps.length}
          </span>
          <button type="button" className="tour-x" onClick={() => setTour(null)} aria-label="Close the tour">
            <Icon name="x" />
          </button>
        </div>
        <h2 className="tour-title">{tour.title}</h2>
        <div className="tour-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
        <p className="tour-caption" aria-live="polite">{current.caption}</p>
        <div className="tour-controls">
          <div className="tour-side">
            <button type="button" className="btn ghost sm" onClick={() => go(step - 1)} disabled={step === 0}>
              <Icon name="arrow" className="flip" /> Back
            </button>
            {!playing && !isLast && (
              <button type="button" className="btn ghost sm" onClick={() => setPlaying(true)}>Play</button>
            )}
            {playing && (
              <button type="button" className="btn ghost sm" onClick={() => setPlaying(false)}>Pause</button>
            )}
          </div>
          <div className="tour-side">
            {isLast ? (
              <button type="button" className="btn sm" onClick={() => setTour(null)}>
                Done, my turn <Icon name="arrow" className="arrow" />
              </button>
            ) : (
              <button type="button" className="btn sm" onClick={() => go(step + 1)}>
                Next <Icon name="arrow" className="arrow" />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
