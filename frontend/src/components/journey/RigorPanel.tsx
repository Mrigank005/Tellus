import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../Icon'
import { LABELS, mannKendall } from '../../engine/stats'
import { pEq } from '../../engine/narrative'
import { prefersReducedMotion } from '../../styles/tokens'
import type { JourneyVerdict } from './StoryVerdict'
import { toneOf } from './StoryChart'
import { RealHist, RealMini } from './StoryRealCharts'

type Rigor = 'naive' | 'shuffled' | 'corrected'
const TOTAL = 500
const FRAMES = 10
const FRAME_MS = 220

function shuffled(a: number[]): number[] {
  const b = a.slice()
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[b[i], b[j]] = [b[j], b[i]]
  }
  return b
}

/** Mann-Kendall S: pairs of years that rise minus pairs that fall. */
function kendallS(y: number[]): number {
  let s = 0
  for (let i = 0; i < y.length - 1; i++) for (let j = i + 1; j < y.length; j++) s += Math.sign(y[j] - y[i])
  return s
}

/**
 * Is it real, or just weather? The same record read three ways: the naive Mann-Kendall test,
 * 500 live shuffles of the real years, and the persistence-corrected test Tellus uses.
 * Used by the journey and the field desk.
 */
export default function RigorPanel({ v, customNote = 'A region you draw is tested in the field desk.' }: {
  v: JourneyVerdict | null
  /** what to say when the question is a drawn region, which this panel does not compute */
  customNote?: string
}) {
  const [rigor, setRigor] = useState<Rigor>('corrected')
  const [scores, setScores] = useState<number[] | null>(null)
  const [example, setExample] = useState<number[] | null>(null)
  const [running, setRunning] = useState(false)
  const token = useRef(0)

  // a new question means a new series: drop any shuffle that belonged to the old one
  const key = v?.key
  useEffect(() => {
    token.current++
    setScores(null); setExample(null); setRunning(false)
  }, [key])
  useEffect(() => () => { token.current++ }, [])

  const full = v?.status === 'ready' && v.summary ? v : null
  const s = full?.summary ?? null
  const tone = full ? toneOf(full.label) : 'none'
  const varS = useMemo(() => (full ? mannKendall(full.values).varS : NaN), [full])

  async function runShuffle() {
    if (!full || running) return
    const mine = ++token.current
    const values = full.values
    const reduce = prefersReducedMotion()
    const frames = reduce ? 1 : FRAMES
    const per = TOTAL / frames
    const acc: number[] = []
    setRigor('shuffled'); setRunning(true); setScores([])
    for (let f = 0; f < frames; f++) {
      if (token.current !== mine) return
      setExample(shuffled(values))
      for (let k = 0; k < per; k++) acc.push(kendallS(shuffled(values)))
      setScores(acc.slice())
      if (!reduce) await new Promise((r) => setTimeout(r, FRAME_MS))
    }
    if (token.current === mine) setRunning(false)
  }

  const realS = s ? s.mkS : NaN
  const matched = scores && s ? scores.filter((x) => Math.abs(x) >= Math.abs(realS)).length : null
  const done = !!scores && scores.length >= TOTAL && !running
  const naiveDiffers = !!s && s.mkP < (full?.cfg?.alpha ?? 0.05) && s.mkPAdj >= (full?.cfg?.alpha ?? 0.05)
  const detected = full?.label === LABELS.detectedIncrease || full?.label === LABELS.detectedDecrease

  const subHist: Record<Rigor, string> = {
    naive: 'The ordinary test assumes every year is independent of the last. Real climate is not: unusual years tend to come in runs.',
    shuffled: 'The trend score of the real record (pairs of years that rise minus pairs that fall), against 500 shuffled versions of it.',
    corrected: 'Tellus widens the chance curve for years that cluster before it calls a trend. The faint curve is the ordinary test.',
  }

  let verdictLine: JSX.Element
  let announce = ''
  if (!full || !s) {
    verdictLine = <span>There is no series to test for this question.</span>
  } else if (rigor === 'naive') {
    verdictLine = (
      <>
        <span className="stamp none">Naive test</span>
        <span>
          Chance of a trend this strong by luck: <span className="num">{pEq(s.mkP)}</span>, if every year were independent.{' '}
          {s.mkP < (full.cfg?.alpha ?? 0.05) ? 'On this test: a real trend.' : 'On this test: could be weather.'}
        </span>
      </>
    )
  } else if (rigor === 'shuffled') {
    if (matched === null) {
      verdictLine = <><span className="stamp none">Shuffled</span><span>Press <b>Shuffle the years</b> to build the cloud of chance.</span></>
    } else {
      const outcome = !done ? '' : matched === 0
        ? ' None did, so the order of the years matters here.'
        : matched / TOTAL < 0.05 ? ' Very few did, so the order of the years matters here.'
        : ' Many did, so this could just be weather.'
      announce = done ? `${matched} of ${TOTAL} shuffled records matched the real trend.${outcome}` : ''
      verdictLine = (
        <>
          <span className="stamp none">{matched} of {scores?.length}</span>
          <span>shuffled records matched the real trend.{outcome}</span>
        </>
      )
    }
  } else {
    verdictLine = (
      <>
        <span className={`stamp ${tone}`}>Corrected</span>
        <span>
          Allowing for years that cluster (about <span className="num">{Math.round(s.nEff)}</span> independent years of{' '}
          <span className="num">{s.n}</span>): <span className="num">{pEq(s.mkPAdj)}</span>.{' '}
          {detected ? 'Still a real trend.' : 'Not clear of ordinary weather.'}
          {naiveDiffers ? ' The naive test would have called this real.' : ''}
        </span>
      </>
    )
  }

  return (
    <div className="st-rigor">
    <div className="st-controls">
      <div className="seg" role="group" aria-label="How strict the test is">
        {(['naive', 'shuffled', 'corrected'] as Rigor[]).map((r) => (
          <button key={r} type="button" aria-pressed={rigor === r} disabled={!full} onClick={() => setRigor(r)}>
            {r === 'naive' ? 'Naive' : r === 'shuffled' ? 'Shuffled' : 'Corrected'}
          </button>
        ))}
      </div>
      <button className="btn" type="button" onClick={runShuffle} disabled={!full || running}>
        <Icon name="shuffle" />{running ? 'Shuffling…' : done ? 'Shuffle again' : 'Shuffle the years'}
      </button>
    </div>

    {!full && v && (
      <p className="st-empty st-empty-inline">
        {v.status === 'custom'
          ? customNote
          : v.status === 'nodata'
            ? 'There is no record to test for this place and measure. Change the question above.'
            : `Only ${v.nValid} valid ${v.nValid === 1 ? 'year' : 'years'} here, too few to test for a trend.`}
      </p>
    )}

    {full && s && (
      <div className="st-real-grid">
        <div className="st-panel">
          <h3>{full.place.title}: the real order of the years</h3>
          <p className="st-sub">
            {example
              ? 'The plain dots are the real years. The teal dots are the same values in one shuffled order.'
              : 'Each dot is one year. Shuffling keeps the same values but forgets when they happened.'}
          </p>
          <RealMini v={full} tone={tone} example={example} />
        </div>
        <div className="st-panel">
          <h3>How unusual is the real trend?</h3>
          <p className="st-sub">{subHist[rigor]}</p>
          <RealHist
            n={s.n} realS={realS} tone={tone} mode={rigor} scores={scores}
            varS={varS} varFactor={s.varFactor}
          />
          <div className="st-verdict-line">{verdictLine}</div>
          {rigor === 'shuffled' && done && (
            <p className="note st-after">
              Shuffling breaks up runs of similar years, so it is a fair test only if years are independent.
              The Corrected view puts that back in.
            </p>
          )}
          <span className="sr" role="status" aria-live="polite">{announce}</span>
        </div>
      </div>
    )}
    </div>
  )
}
