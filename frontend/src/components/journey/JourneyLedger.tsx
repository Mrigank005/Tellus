import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../Icon'
import { useStore } from '../../state/store'

/** public/data/validation.json, built by pipeline/build_validation.py */
type Status = 'pass' | 'partial' | 'fail' | 'not-comparable'
interface Case {
  id: string
  title: string
  question: string
  period_ours: string
  units: string
  decimals: number
  our: { label: string; value: number | null; ci_low: number | null; ci_high: number | null }
  reference: { label: string; value: number | null; low: number | null; high: number | null }
  status: Status
}
interface Validation {
  summary: { scored: number; pass: number; partial: number; fail: number; not_comparable: number }
  cases: Case[]
}

const STAMP: Record<Status, { cls: string; icon: IconName | null; text: string }> = {
  pass: { cls: 'pass', icon: 'check', text: 'Pass' },
  partial: { cls: 'partial', icon: 'tilde', text: 'Partial' },
  fail: { cls: 'miss', icon: 'x', text: 'Miss' },
  'not-comparable': { cls: 'na', icon: null, text: 'Not comparable' },
}

const num = (x: number | null | undefined) => typeof x === 'number' && Number.isFinite(x)

function f(x: number, d: number, signed = false): string {
  const t = Math.abs(x).toFixed(d)
  return `${x < 0 ? '−' : signed && Number(t) !== 0 ? '+' : ''}${t}`
}

/** Our number, with its interval and units; sign only for changes. */
function ours(c: Case): { main: string; units: string; ci: string | null } {
  if (!num(c.our.value)) return { main: 'Not computed', units: '', ci: null }
  const signed = /per decade|total rise|change/i.test(c.units)
  const ci = num(c.our.ci_low) && num(c.our.ci_high)
    ? `95% interval ${f(c.our.ci_low as number, c.decimals, signed)} to ${f(c.our.ci_high as number, c.decimals, signed)}`
    : null
  return { main: f(c.our.value as number, c.decimals, signed), units: c.units, ci }
}

/** The published value: a range, a threshold, or a single number. */
function reference(c: Case): string {
  const { value, low, high } = c.reference
  const signed = /per decade|total rise|change/i.test(c.units)
  if (num(low) && num(high)) return `${f(low as number, c.decimals, signed)} to ${f(high as number, c.decimals, signed)}`
  if (num(low)) return `${f(low as number, c.decimals, signed)} or more`
  if (num(value)) return f(value as number, c.decimals, signed)
  return 'No number published for this'
}

export default function JourneyLedger() {
  const go = useStore((s) => s.go)
  const [data, setData] = useState<Validation | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('./data/validation.json')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<Validation> })
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [])

  const sum = data?.summary
  return (
    <section className="screen st-section" id="ledger" aria-labelledby="h-ledger">
      <div className="wrap">
        <h2 className="title" id="h-ledger">We checked our own work.</h2>
        <p className="lede">
          Before trusting Tellus, we compared it with published science. Every comparison is here, including the
          ones we missed, with the rule written down before we looked.
        </p>

        {error && <p className="st-empty st-empty-inline">The checks could not be loaded ({error}). They are also on the full checks page.</p>}
        {!data && !error && <p className="note st-loading" role="status">Loading the checks…</p>}

        {sum && (
          <div className="st-tally" aria-label="Tally of the checks">
            <span className="stamp pass"><Icon name="check" />{sum.pass} pass</span>
            <span className="stamp partial"><Icon name="tilde" />{sum.partial} partial</span>
            <span className="stamp miss"><Icon name="x" />{sum.fail} miss</span>
            <span className="stamp na">{sum.not_comparable} not comparable</span>
          </div>
        )}

        {data && (
          <div className="st-ledger" role="table" aria-label="Tellus compared with published values">
            <div className="st-row st-head" role="row">
              <span role="columnheader">Question</span>
              <span role="columnheader">Tellus</span>
              <span role="columnheader">Published</span>
              <span role="columnheader">Result</span>
            </div>
            {data.cases.map((c) => {
              const o = ours(c)
              const st = STAMP[c.status] ?? STAMP['not-comparable']
              return (
                <div className="st-row" role="row" key={c.id}>
                  <span className="st-q" role="cell">
                    {c.title}
                    <span className="note">{c.question}</span>
                  </span>
                  <span className="st-v" role="cell">
                    <span className="st-v-main num">{o.main}</span>
                    {o.units && <span className="st-v-units">{o.units}</span>}
                    {o.ci && <span className="note num">{o.ci}</span>}
                  </span>
                  <span className="st-v" role="cell">
                    <span className="st-v-main num">{reference(c)}</span>
                    <span className="note">{c.reference.label}</span>
                  </span>
                  <span className="st-res" role="cell">
                    <span className={`stamp ${st.cls}`}>{st.icon && <Icon name={st.icon} />}{st.text}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <div className="st-ledger-foot">
          <button className="btn ghost" type="button" onClick={() => go('check')}>
            See every check<Icon name="arrow" className="arrow" />
          </button>
        </div>
      </div>
    </section>
  )
}
