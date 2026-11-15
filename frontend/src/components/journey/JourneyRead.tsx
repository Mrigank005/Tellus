import { Icon } from '../Icon'
import { useStore } from '../../state/store'
import { LABELS } from '../../engine/stats'
import { plainHorizon } from '../../engine/explain'
import {
  capFirst, fmtP, fmtSigned, useJourneyVerdict, verdictTitle, type JourneyVerdict,
} from './StoryVerdict'
import { toneOf } from './StoryChart'
import StoryPanel from './StoryPanel'

const STAMP_TEXT: Record<string, string> = {
  up: 'Detected increase', down: 'Detected decrease', none: 'No clear trend',
}

function scrollToAsk() {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  document.getElementById('ask')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' })
}

/** The persistence-aware plain sentence under the big number. */
function plainSentence(v: JourneyVerdict): string {
  const s = v.summary
  if (!s) return ''
  const n = s.n, nEff = Math.round(s.nEff)
  if (v.label === LABELS.noDetectedTrend) {
    const base = 'Changes this small sit well inside ordinary year-to-year swings, so Tellus does not call it a trend.'
    const h = v.horizon
    const more = h ? ` ${plainHorizon(h.moreYears, h.cappedAt)}` : ''
    return base + more
  }
  const rise = v.label === LABELS.detectedIncrease ? 'rise' : 'fall'
  const strength = s.mkPAdj < 0.001 ? 'would almost never appear by chance'
    : s.mkPAdj < 0.01 ? 'is very unlikely to be chance' : 'is unlikely to be chance'
  if (s.lag1R > 0.2) {
    return `Years here tend to resemble their neighbours, so Tellus counts only about ${nEff} of the ${n} years as truly independent. Even so, a ${rise} this steady ${strength}.`
  }
  return `A ${rise} this steady ${strength}, even after allowing for years that cluster together.`
}

function Specimen({ v }: { v: JourneyVerdict }) {
  const s = v.summary
  const tone = toneOf(v.label)
  const what = [capFirst(v.noun), v.seasonText, v.span].filter(Boolean).join(', ')
  const clear = v.em?.status === 'emerged' && v.em.emergenceYear !== null ? String(v.em.emergenceYear) : 'not yet clear'
  return (
    <article className="st-specimen" aria-labelledby="st-sp-place">
      <Icon name="pin" className="st-pin" />
      <h3 id="st-sp-place">{v.place.title}</h3>
      <div className="st-what">{what}</div>
      <div className="st-stamp-row">
        {s ? (
          <span className={`stamp ${tone}`}>
            <Icon name={tone === 'none' ? 'tilde' : 'check'} />{STAMP_TEXT[tone]}
          </span>
        ) : (
          <span className="stamp na hatch">Too little data</span>
        )}
      </div>
      {s ? (
        <>
          <div className="st-big">
            {fmtSigned(v.slopeDec, v.decimals)}<small>{v.unitsShort} per decade</small>
          </div>
          <div className="st-ci">
            Likely between <span className="num">{fmtSigned(v.ciLowDec, v.decimals)}</span> and{' '}
            <span className="num">{fmtSigned(v.ciHighDec, v.decimals)}</span>
          </div>
          <p className="st-plain">{plainSentence(v)}</p>
          <dl className="st-facts">
            <dt>Years used</dt><dd>{s.n}</dd>
            <dt>Independent years</dt><dd>about {Math.round(s.nEff)}</dd>
            <dt>Clear since</dt><dd>{clear}</dd>
            <dt>Possible shift</dt><dd>{v.cpVisible && v.pt?.year ? `around ${v.pt.year}` : 'none found'}</dd>
            <dt>Adjusted p</dt><dd>{fmtP(s.mkPAdj)}</dd>
          </dl>
          {s.caution && s.cautionReasons.length > 0 && (
            <p className="st-caution note"><b>Read with care:</b> {s.cautionReasons.join('; ')}.</p>
          )}
        </>
      ) : (
        <>
          <div className="st-big st-big-none">–</div>
          <p className="st-plain">
            Only {v.nValid} valid {v.nValid === 1 ? 'year' : 'years'} in this window. Tellus needs at least{' '}
            {v.cfg?.minYears} before it will say anything about a trend, so it says nothing rather than guess.
          </p>
        </>
      )}
    </article>
  )
}

export default function JourneyRead() {
  const { v, pending, error } = useJourneyVerdict()
  const go = useStore((s) => s.go)

  const full = v?.status === 'ready' ? v : null
  const lede = full
    ? `${full.nValid} yearly ${full.nValid === 1 ? 'value' : 'values'} from ${full.source.label}, ${full.span}`
      + (full.summary ? ', read with a test that allows for years that cluster together.' : '.')
    : null

  return (
    <section className="screen st-section" id="read" aria-labelledby="h-read" aria-busy={pending}>
      <div className="wrap">
        <h2 className="title" id="h-read">{error ? 'Tellus could not load the data.' : verdictTitle(v)}</h2>
        {error && <p className="lede">{error} Check your connection and reload the page.</p>}
        {!error && lede && <p className="lede">{lede}</p>}
        {!error && v && v.status !== 'ready' && (
          <div className="st-empty">
            <p>{v.message}</p>
            <div className="st-empty-actions">
              {v.status === 'custom'
                ? <button className="btn" onClick={() => go('workspace')}>Open the field desk<Icon name="arrow" className="arrow" /></button>
                : <button className="btn ghost" onClick={scrollToAsk}>Change the question</button>}
            </div>
          </div>
        )}
        {!error && !v && <p className="lede st-loading" role="status">Reading the record…</p>}

        {full && (
          <div className="st-read-grid">
            <Specimen v={full} />
            <StoryPanel v={full} />
          </div>
        )}
      </div>
    </section>
  )
}
