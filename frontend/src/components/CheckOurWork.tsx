import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'

/** "Check our work": our numbers next to published / independent reference values.
 *  Data comes from public/data/validation.json, built by pipeline/build_validation.py. */

type Status = 'pass' | 'partial' | 'fail' | 'not-comparable'

interface Source { citation: string; url: string; quote?: string }
interface Case {
  id: string
  title: string
  question: string
  kind: string
  region: string
  period_ours: string
  period_reference: string
  units: string
  decimals: number
  our: { label: string; value: number | null; ci_low: number | null; ci_high: number | null }
  reference: { label: string; value: number | null; low: number | null; high: number | null }
  rule: string
  status: Status
  explanation: string
  sources: Source[]
  details?: { columns: string[]; rows: (string | number | boolean | null)[][] }
}
interface Validation {
  references_verified_on: string
  method: string
  summary: { scored: number; pass: number; partial: number; fail: number; not_comparable: number }
  cases: Case[]
}

const STATUS_LABEL: Record<Status, string> = {
  pass: 'Pass',
  partial: 'Partial',
  fail: 'Does not match',
  'not-comparable': 'Not comparable',
}

function fmt(v: number | null | undefined, d: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  return v.toFixed(d)
}

function ourText(c: Case): string {
  if (c.our.value === null) return 'not computed'
  const base = fmt(c.our.value, c.decimals)
  if (c.our.ci_low !== null && c.our.ci_high !== null) {
    return `${base}  (${fmt(c.our.ci_low, c.decimals)} to ${fmt(c.our.ci_high, c.decimals)})`
  }
  return base
}

function refText(c: Case): string {
  const { value, low, high } = c.reference
  if (value === null && low === null) return 'see text'
  if (low !== null && high !== null) return `${fmt(low, c.decimals)} to ${fmt(high, c.decimals)}`
  if (low !== null) return `${fmt(low, c.decimals)} or more`
  return fmt(value, c.decimals)
}

const STAMP: Record<Status, { cls: string; icon: IconName | null }> = {
  pass: { cls: 'pass', icon: 'check' },
  partial: { cls: 'partial', icon: 'tilde' },
  fail: { cls: 'miss', icon: 'x' },
  'not-comparable': { cls: 'na', icon: null },
}

function Stamp({ status }: { status: Status }) {
  const s = STAMP[status]
  return (
    <span className={`stamp ${s.cls}`}>
      {s.icon && <Icon name={s.icon} />}
      {STATUS_LABEL[status]}
    </span>
  )
}

function LedgerEntry({ c }: { c: Case }) {
  const comparable = c.status !== 'not-comparable'
  return (
    <article className="chk-entry" aria-labelledby={`chk-${c.id}`}>
      <div className="chk-row">
        <div className="chk-q">
          <h3 id={`chk-${c.id}`}>{c.title}</h3>
          <p>{c.question}</p>
        </div>
        <div className="chk-cell chk-ours">
          <span className="chk-k">Our number ({c.period_ours})</span>
          <span className="chk-v mono">{comparable ? ourText(c) : 'not compared'}</span>
          {comparable && <span className="chk-u">{c.units}</span>}
        </div>
        <div className="chk-cell chk-ref">
          <span className="chk-k">Published reference ({c.period_reference})</span>
          <span className="chk-v mono">{comparable ? refText(c) : 'see below'}</span>
          {c.sources[0] && (
            <a className="source" href={c.sources[0].url} target="_blank" rel="noreferrer">
              <Icon name="book" /><span>{c.sources[0].citation}</span>
            </a>
          )}
        </div>
        <div className="chk-stamp"><Stamp status={c.status} /></div>
      </div>

      <div className="chk-body">
        <div className="chk-prose">
          {comparable && <p className="chk-region"><b>Region:</b> {c.region}</p>}
          <p><b>Ours:</b> {c.our.label}</p>
          <p><b>Reference:</b> {c.reference.label}</p>
          <p><b>The rule (fixed before we looked at the result):</b> {c.rule}</p>
          <p className="chk-explain">{c.explanation}</p>
        </div>

        <div className="chk-sources">
          <h4>Sources</h4>
          <ul>
            {c.sources.map((s) => (
              <li key={s.url + s.citation}>
                <a href={s.url} target="_blank" rel="noreferrer">{s.citation}</a>
                {s.quote && <blockquote>{s.quote}</blockquote>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {c.details && (
        <details className="chk-details">
          <summary>Region-by-region detail</summary>
          <div className="chk-tablewrap">
            <table className="chk-table">
              <thead>
                <tr>{c.details.columns.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
              </thead>
              <tbody>
                {c.details.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((cell, j) => (
                      <td key={j}>{typeof cell === 'boolean' ? (cell ? 'yes' : 'no') : cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </article>
  )
}

export default function CheckOurWork() {
  const [data, setData] = useState<Validation | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch('./data/validation.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch((e) => setErr(String(e?.message ?? e)))
  }, [])

  if (err) {
    return (
      <div className="chk wrap">
        <div className="cautionbox">Could not load the validation results ({err}).</div>
      </div>
    )
  }
  if (!data) return <div className="loading"><div className="spinner" /> Loading checks...</div>

  const s = data.summary
  return (
    <div className="chk wrap">
      <header className="chk-head">
        <h1 className="title">We checked our own work.</h1>
        <p className="lede">
          Our numbers next to published or independent reference values, each with a pass rule
          that was written down before the result was known.
        </p>

        <p className="chk-score"><span className="num">{s.pass}</span> of <span className="num">{s.scored}</span> checks pass</p>
        <div className="chk-tally">
          <span className="stamp pass"><Icon name="check" />{s.pass} pass</span>
          <span className="stamp partial"><Icon name="tilde" />{s.partial} partial</span>
          <span className="stamp miss"><Icon name="x" />{s.fail} do not match</span>
          {s.not_comparable > 0 && (
            <span className="stamp na">{s.not_comparable} not comparable (explained)</span>
          )}
        </div>
        <p className="note chk-verified">
          We report the misses as plainly as the passes. Reference figures were re-read from the sources
          linked on each entry on {data.references_verified_on}.
        </p>
      </header>

      <div className="cautionbox chk-caution">
        <b>What these checks do and do not prove.</b> They show that the data we ship and the statistics we
        run give answers in line with independent science, within the stated rule. They do not prove that
        every region, season or variable in the app is right: a reanalysis is a model, regional boxes
        are coarse, and short records have wide uncertainty. A partial result usually points to a
        known difference in what is being measured, and each entry says which.
      </div>

      <div className="chk-ledger" role="list">
        {data.cases.map((c) => (
          <div role="listitem" key={c.id}><LedgerEntry c={c} /></div>
        ))}
      </div>

      <p className="note chk-method">{data.method}</p>
    </div>
  )
}
