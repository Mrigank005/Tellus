/**
 * Design tokens for code that paints pixels itself (canvas, ECharts, MapLibre).
 * CSS reads the same values from custom properties in styles.css; keep both in sync.
 *
 * Usage in a chart component:
 *   const theme = useTheme((s) => s.theme)
 *   const option = useMemo(() => { const t = tokens(); ... }, [data, theme])
 */
import type { Theme } from '../state/theme'

export interface Tokens {
  paper: string; paperRaised: string; paperSunk: string
  ink: string; inkSoft: string; inkFaint: string
  line: string; copper: string
  leaf: string; leafDeep: string
  sun: string; sunSoft: string
  ember: string; tide: string
  fontBody: string; fontData: string; fontDisplay: string
}

const DAY: Tokens = {
  paper: '#F6F1E3', paperRaised: '#FFFCF4', paperSunk: '#ECE3CC',
  ink: '#16302A', inkSoft: '#43574D', inkFaint: '#56665C',
  line: '#D6CAAE', copper: '#8A5A33',
  leaf: '#2C7048', leafDeep: '#1E5636',
  sun: '#E8B13A', sunSoft: '#F6DFA4',
  ember: '#A34E2A', tide: '#24606E',
  fontBody: '"Atkinson Hyperlegible Next", "Segoe UI", system-ui, sans-serif',
  fontData: '"Atkinson Hyperlegible Mono", ui-monospace, "Cascadia Mono", monospace',
  fontDisplay: '"Gloock", "Iowan Old Style", Georgia, serif',
}

const DUSK: Tokens = {
  ...DAY,
  paper: '#0E1D17', paperRaised: '#15291F', paperSunk: '#0A1611',
  ink: '#EEE7D2', inkSoft: '#B9C2B3', inkFaint: '#9AA596',
  line: '#2A4236', copper: '#C9955F',
  leaf: '#79C796', leafDeep: '#9CDAB2',
  sun: '#F0C25A', sunSoft: '#4A3E1A',
  ember: '#E58A5C', tide: '#6FB3C1',
}

/** Current token values. Pass the theme explicitly, or let it read the <html> attribute. */
export function tokens(theme?: Theme): Tokens {
  const t = theme ?? (document.documentElement.dataset.theme === 'dusk' ? 'dusk' : 'day')
  return t === 'dusk' ? DUSK : DAY
}

/**
 * Diverging 9-step data scale, decrease/cooling (tide, index 0) to increase/warming (ember, index 8).
 * Colour shows direction and size of change, never "good" or "bad".
 * The middle step changes in Dusk so "no change" stays quiet on dark paper.
 */
export const DATA_SCALE_DAY = ['#1D4F5C', '#2C6E7E', '#5E9AA3', '#A9C9C6', '#EFE8D6', '#EBC08E', '#D88E5A', '#B85A32', '#8A3A1E']
export const DATA_SCALE_DUSK = ['#1D4F5C', '#2C6E7E', '#5E9AA3', '#A9C9C6', '#3A4A40', '#EBC08E', '#D88E5A', '#B85A32', '#8A3A1E']
export function dataScale(theme?: Theme): string[] {
  const t = theme ?? (document.documentElement.dataset.theme === 'dusk' ? 'dusk' : 'day')
  return t === 'dusk' ? DATA_SCALE_DUSK : DATA_SCALE_DAY
}

/** Map a value in [-max, max] onto the data scale (clamped). NaN returns null. */
export function scaleColor(value: number, max: number, theme?: Theme): string | null {
  if (!Number.isFinite(value) || !(max > 0)) return null
  const s = dataScale(theme)
  const f = Math.max(-1, Math.min(1, value / max))
  const idx = Math.round((f + 1) / 2 * (s.length - 1))
  return s[idx]
}

/** Shared ECharts base: transparent background, themed axes, tooltip, and fonts. Spread it into options. */
export function chartBase(theme?: Theme) {
  const t = tokens(theme)
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: t.fontBody, color: t.inkSoft },
    tooltip: {
      backgroundColor: t.ink, borderColor: t.ink, borderWidth: 0,
      textStyle: { color: t.paperRaised, fontFamily: t.fontBody, fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 12px 32px -16px rgb(22 48 42 / .45);',
    },
    axis: {
      axisLine: { lineStyle: { color: t.line } },
      axisTick: { lineStyle: { color: t.line } },
      axisLabel: { color: t.inkFaint, fontFamily: t.fontData, fontSize: 11 },
      splitLine: { lineStyle: { color: t.line, type: 'dashed' as const, opacity: 0.6 } },
      nameTextStyle: { color: t.inkFaint, fontFamily: t.fontBody, fontSize: 12 },
    },
    t,
  }
}

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'
export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}
