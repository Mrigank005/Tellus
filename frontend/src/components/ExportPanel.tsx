import type { Catalog, VariableMeta, TrendPack } from '../engine/loader'
import type { RegionAnalysis } from '../engine/analysis'
import type { Summarized } from '../engine/stats'

/** Evidence package export: CSV, provenance JSON, printable report. */
export default function ExportPanel({ cat, variable, regionName, polygon, windowMeta, seasonLabel, analysis, pack, compare }: {
  cat: Catalog
  variable: VariableMeta
  regionName: string
  polygon: number[][] | null
  windowMeta: { start: number; end: number; label: string }
  seasonLabel: string
  analysis: RegionAnalysis
  pack: TrendPack | null
  compare?: { name: string; analysis: RegionAnalysis }
}) {
  const s = analysis.summary as (Summarized | { n: number; label: string })

  function download(name: string, content: string | Blob, type = 'text/plain') {
    const blob = content instanceof Blob ? content : new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  async function exportCsv() {
    const rows = ['year,value']
    analysis.years.forEach((y, i) => {
      const v = analysis.series.values[i]
      rows.push(`${y},${Number.isFinite(v) ? v.toFixed(4) : ''}`)
    })
    if (compare) {
      rows.push('', 'year,comparison_value')
      compare.analysis.years.forEach((y, i) => {
        const v = compare.analysis.series.values[i]
        rows.push(`${y},${Number.isFinite(v) ? v.toFixed(4) : ''}`)
      })
    }
    download(`tellus_${variable.id}_${analysis.window.start}-${analysis.window.end}.csv`,
      rows.join('\n'), 'text/csv')
  }

  async function exportJson() {
    let provenance: unknown = null
    try {
      provenance = await (await fetch('./data/provenance.json')).json()
    } catch { /* offline asset missing */ }
    const bundle = {
      generated_at: new Date().toISOString(),
      tool: 'Tellus 1.0',
      variable: {
        id: variable.id, long_name: variable.long_name, units: variable.units,
        trend_units: variable.trend_units, aggregation: variable.aggregation,
      },
      region: { name: regionName, polygon, n_cells: analysis.series.nCells },
      period: { start: analysis.window.start, end: analysis.window.end, season: seasonLabel },
      results: {
        region: analysis.summary,
        coverage_min_year_fraction: +analysis.coverage.toFixed(4),
        map: pack ? {
          n_eligible_cells: pack.nEligible,
          family: 'one variable x one domain x one window x one season, BH-FDR corrected',
        } : null,
      },
      comparison: compare ? { region: compare.name, results: compare.analysis.summary } : null,
      methods: cat.methods,
      provenance,
    }
    download(`tellus_${variable.id}_evidence.json`,
      JSON.stringify(bundle, null, 2), 'application/json')
  }

  const slope10 = 'senSlope' in s ? s.senSlope * 10 : null

  return (
    <div>
      <p className="muted small">
        Everything an analysis produces is reproducible: the data version, the exact method
        settings, the regional series, and the full provenance chain — enough for a teacher,
        a student, or a scientist to check the work.
      </p>
      <div className="row">
        <button className="ghost" onClick={exportCsv}>⬇ Observations CSV</button>
        <button className="ghost" onClick={exportJson}>⬇ Provenance JSON</button>
        <button className="ghost" onClick={() => window.print()}>🖨 Printable report</button>
      </div>
      <div className="card" style={{ marginTop: 14, background: '#fff', color: '#111', border: 'none' }}>
        <div style={{ display: 'none' }} />
        <h3 style={{ color: '#111' }}>Tellus evidence report</h3>
        <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Variable</td><td><b>{variable.long_name}</b> ({variable.units})</td></tr>
            <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Region</td><td>{regionName} — {analysis.series.nCells} grid cells ({polygon ? 'polygon centres, cos-latitude weighted' : '—'})</td></tr>
            <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Period</td><td>{windowMeta.label} · {seasonLabel}</td></tr>
            <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Verdict</td><td><b>{s.label}</b></td></tr>
            {slope10 !== null && Number.isFinite(slope10) && (
              <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Trend</td>
                <td>{slope10 >= 0 ? '+' : ''}{slope10.toFixed(3)} {variable.trend_units}
                  {' (95% CI ' + ((s as Summarized).ciLow * 10).toFixed(3) + ' to ' + ((s as Summarized).ciHigh * 10).toFixed(3) + ')'}</td></tr>
            )}
            <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Data</td><td>NASA POWER monthly (MERRA-2), 1981–2025 · GPCP V2.3 for observed precipitation</td></tr>
            <tr><td style={{ padding: '3px 12px 3px 0', color: '#555' }}>Method</td><td>Sen's slope · Mann-Kendall (α={cat.methods!.alpha}) · Gilbert 95% CI · BH-FDR over {pack?.nEligible.toLocaleString() ?? '—'} map cells</td></tr>
          </tbody>
        </table>
        <p style={{ color: '#555', fontSize: 12, marginTop: 10 }}>
          Generated by Tellus. Colour never encodes “good” or “bad”. Missing months are
          never treated as zero. Results describe the analysed record, not the future.
        </p>
      </div>
    </div>
  )
}
