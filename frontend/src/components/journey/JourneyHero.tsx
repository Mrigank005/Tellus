import { Icon } from '../Icon'
import { useStore } from '../../state/store'
import HeroRings from './HeroRings'

/** Smooth-scroll to a journey section, gentler (instant) under reduced motion. */
export function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  let reduce = false
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* ignore */ }
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

/** First viewport: the headline and the tree-ring disc of the real whole-Earth record. */
export default function JourneyHero() {
  const go = useStore((s) => s.go)
  return (
    <>
      <section id="hero" aria-labelledby="h-hero">
        <div className="wrap">
          <div className="hero">
            <div className="hero-copy">
              <h1 id="h-hero">Earth keeps a diary. <em>Tellus reads it.</em></h1>
              <p className="lede">
                Each ring in this tree is one year of the planet's air temperature, from 1981 at the heart to 2025 at the bark. Warmer years glow ember, cooler years tide.
                Ask Tellus a question about any place and it reads the NASA record to tell you what changed, and whether it is real or just weather.
              </p>
              <div className="actions">
                <button type="button" className="btn" onClick={() => scrollToSection('ask')}>
                  Ask your first question <Icon name="arrow" className="arrow" />
                </button>
                <button type="button" className="btn ghost" onClick={() => go('workspace')}>Open the field desk</button>
              </div>
              <div className="meta">
                <a className="source" href="https://power.larc.nasa.gov/" target="_blank" rel="noopener noreferrer">
                  <Icon name="sat" />NASA POWER · MERRA-2 reanalysis
                </a>
                <span className="note">Whole-Earth average, compared with 1981–2010. Hover the rings or use the arrow keys to read a year.</span>
              </div>
            </div>
            <HeroRings />
          </div>
        </div>
      </section>
      <div className="rule" />
    </>
  )
}
