/** HTML legend for the charts: wraps cleanly on phones, readable by screen readers, themed by CSS variables. */
export interface LegendItem {
  label: string
  /** CSS colour, e.g. 'var(--ink)' */
  color: string
  line?: 'solid' | 'dashed' | 'none'
  dot?: 'circle' | 'diamond' | 'none'
  band?: boolean
}

export default function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="clegend">
      {items.map((it) => (
        <li key={it.label}>
          <span className={`k ${it.band ? 'band' : ''} l-${it.line ?? 'solid'} d-${it.dot ?? 'none'}`}
            style={{ ['--c' as string]: it.color }} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  )
}
