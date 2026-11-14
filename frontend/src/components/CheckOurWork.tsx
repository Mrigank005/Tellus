import { useEffect, useState } from 'react'

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

function CaseCard({ c }: { c: Case }) {
  return (
    <div className="card checkcard">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ marginBottom: 2 }}>{c.title}</h3>
          <div className="muted small">{c.question}</div>
        </div>
        <span className={`pill pill-${c.status}`}>{STATUS_LABEL[c.status]}</span>
      </div>

      {c.status !== 'not-comparable' && (
        <div style={{ marginTop: 10 }}>
          <div className="statrow">
            <span className="k">Our number ({c.period_ours})</span>
            <span className="v">{ourText(c)}</span>
          </div>
          <div className="statrow">
            <span className="k">Reference ({c.period_reference})</span>
            <span className="v">{refText(c)}</span>
          </div>
          <div className="statrow">
            <span className="k">Units</span>
            <span className="v">{c.units}</span>
          </div>
          <div className="statrow">
            <span className="k">Region</span>
            <span className="v" style={{ textAlign: 'right' }}>{c.region}</span>
          </div>
        </div>
      )}

      <p className="small muted" style={{ marginTop: 10 }}><b>Ours:</b> {c.our.label}</p>
      <p className="small muted" style={{ margin: '2px 0 8px' }}><b>Reference:</b> {c.reference.label}</p>

      <p className="small" style={{ marginTop: 8 }}><b>The rule (fixed before we looked at the result):</b> {c.rule}</p>
      <p className="small">{c.explanation}</p>

      {c.details && (
        <details className="small" style={{ marginTop: 6 }}>
          <summary>Region-by-region detail</summary>
          <table className="checktable">
            <thead>
              <tr>{c.details.columns.map((h) => <th key={h}>{h}</th>)}</tr>
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
        </details>
      )}

      <div className="small" style={{ marginTop: 8 }}>
        <b>Sources</b>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {c.sources.map((s) => (
            <li key={s.url + s.citation}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.citation}</a>
              {s.quote && <div className="muted">{s.quote}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
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
      <div className="container">
        <div className="cautionbox">Could not load the validation results ({err}).</div>
      </div>
    )
  }
  if (!data) return <div className="loading"><div className="spinner" /> Loading checks...</div>

  const s = data.summary
  return (
    <div className="container">
      <h2>Check our work</h2>
      <p className="sub">
        Our numbers next to published or independent reference values, each with a pass rule
        that was written down before the result was known.
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ fontSize: 20, marginBottom: 6 }}>
          {s.pass} of {s.scored} checks pass
        </h3>
        <div className="row">
          <span className="pill pill-pass">{s.pass} pass</span>
          <span className="pill pill-partial">{s.partial} partial</span>
          <span className="pill pill-fail">{s.fail} do not match</span>
          {s.not_comparable > 0 && (
            <span className="pill pill-not-comparable">{s.not_comparable} not comparable (explained)</span>
          )}
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          We report the misses as plainly as the passes. Reference figures were re-read from the sources
          linked on each card on {data.references_verified_on}.
        </p>
      </div>

      <div className="cautionbox" style={{ marginBottom: 14 }}>
        <b>What these checks do and do not prove.</b> They show that the data we ship and the statistics we
        run give answers in line with independent science, within the stated rule. They do not prove that
        every region, season or variable in the app is right: a reanalysis is a model, regional boxes
        are coarse, and short records have wide uncertainty. A partial result usually points to a
        known difference in what is being measured, and each card says which.
      </div>

      <div className="checkgrid">
        {data.cases.map((c) => <CaseCard key={c.id} c={c} />)}
      </div>

      <p className="small muted" style={{ marginTop: 14 }}>{data.method}</p>
    </div>
  )
}
