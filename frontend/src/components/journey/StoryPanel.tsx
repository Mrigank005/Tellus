import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import { LABELS } from '../../engine/stats'
import { fmtPlain, fmtSigned, type JourneyVerdict } from './StoryVerdict'
import { StoryChart, type StoryFocus } from './StoryChart'

/**
 * The verdict told as four short answers (how fast, since when, steady or a step, how sure),
 * each linked to the part of the chart it describes. Used by the journey and the field desk.
 */
export function storyLines(v: JourneyVerdict): { k: Exclude<StoryFocus, null>; q: string; body: ReactNode }[] {
  const s = v.summary
  if (!s) return []
  const d = v.decimals, u = v.unitsShort
  const up = v.slopeDec >= 0
  const detected = v.label !== LABELS.noDetectedTrend
  const y0 = v.years[0], y1 = v.years[v.years.length - 1]
  const amount = `${fmtPlain(Math.abs(v.slopeDec), d)} ${u}`
  const out: { k: Exclude<StoryFocus, null>; q: string; body: ReactNode }[] = []

  out.push({
    k: 'trend', q: 'How fast',
    body: detected
      ? <>Since {y0}, {v.noun} has {up ? 'risen' : 'fallen'} by about <b>{amount}</b> per decade.</>
      : <>The best estimate is a {up ? 'rise' : 'fall'} of about <b>{amount}</b> per decade, too small to tell apart from ordinary swings.</>,
  })

  const em = v.em
  let since: ReactNode
  if (em?.status === 'emerged' && em.emergenceYear !== null) {
    since = em.yearsBeforeEnd === 0
      ? <>This only became statistically clear with the latest year, <b>{em.emergenceYear}</b>.</>
      : em.atEarliest
        ? <>Already clear in <b>{em.emergenceYear}</b>, as soon as {v.cfg?.minYears} years of data existed, and clear every year since.</>
        : <>The {up ? 'rise' : 'fall'} became statistically clear in <b>{em.emergenceYear}</b> and has stayed clear every year since.</>
  } else if (em?.everDetected) {
    since = <>It looked clear for some earlier end years but did not stay clear, so Tellus does not call it settled.</>
  } else {
    since = <>The change has not become statistically clear in the {y0}–{y1} record.</>
  }
  out.push({ k: 'toe', q: 'Since when', body: since })

  const pt = v.pt
  out.push({
    k: 'shift', q: 'Steady, or a step?',
    body: v.cpVisible && pt?.year !== undefined
      ? <>The likeliest single step sits around <b>{pt.year}</b>. {pt.stepBetter
          ? 'A step fits better than a straight line, so treat it as a clue, not a result.'
          : 'Exploratory: a straight line fits just as well.'}</>
      : pt?.label === 'insufficient-data'
        ? <>Too few years to look for a single step.</>
        : <>No single jump stands out in this record.</>,
  })

  const conf = Math.round((v.cfg?.conf ?? 0.95) * 100)
  const spansZero = v.ciLowDec <= 0 && v.ciHighDec >= 0
  out.push({
    k: 'sure', q: 'How sure',
    body: detected
      ? <>Tellus is {conf}% sure the true rate lies between <b>{fmtSigned(v.ciLowDec, d)}</b> and <b>{fmtSigned(v.ciHighDec, d)}</b> {u} per decade, after allowing for years that cluster.</>
      : <>The rates that fit the data run from <b>{fmtSigned(v.ciLowDec, d)}</b> to <b>{fmtSigned(v.ciHighDec, d)}</b> {u} per decade{spansZero ? ', and that range includes zero' : ''}.</>,
  })
  return out
}

export default function StoryPanel({ v, heading }: { v: JourneyVerdict; heading?: string }) {
  const [hover, setHover] = useState<StoryFocus>(null)
  const [pinned, setPinned] = useState<StoryFocus>(null)
  useEffect(() => { setPinned(null); setHover(null) }, [v.key])
  const focus = hover ?? pinned
  const full = v
  const lines = storyLines(v)
  return (
    <div className="st-chart-card">
      <div className="st-chart-head">
        <h3>{heading ?? `${full.variable?.aggregation === 'sum' ? 'Total' : 'Average'} ${full.noun} each year`}</h3>
        <span className="st-badges">
          <a className="source" href={full.source.url} target="_blank" rel="noopener noreferrer" title={full.source.title}>
            <Icon name="sat" />{full.source.label}
          </a>
          <span className="source" title="The statistics are calculated on this page, not on a server">
            <Icon name="rings" />Computed in your browser
          </span>
        </span>
      </div>
      <StoryChart v={full} focus={focus} />
      {lines.length > 0 ? (
        <div className="st-story" role="group" aria-label="The story of this record. Point at a sentence to see it on the chart.">
          {lines.map((l) => (
            <button
              key={l.k} type="button" aria-pressed={pinned === l.k}
              className={focus === l.k ? 'on' : ''}
              onMouseEnter={() => setHover(l.k)} onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(l.k)} onBlur={() => setHover(null)}
              onClick={() => setPinned(pinned === l.k ? null : l.k)}
            >
              <span className="st-q">{l.q}</span>
              <span className="st-line">{l.body}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="note st-after">Each dot is one year&rsquo;s value. There are too few valid years to draw a trend.</p>
      )}
    </div>
  )
}
