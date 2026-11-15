/**
 * S5 — plain-language layer. One sentence a student can repeat; the
 * statistics stay available behind "Show the statistics".
 */
import type { Summarized } from './stats'

// What "lower" means for each variable's "higher" phrase, so a detected
// decrease never reads "trending toward warmer".
const OPPOSITE: Record<string, string> = {
  'warmer': 'cooler',
  'warmer nights': 'cooler nights',
  'warmer ocean': 'cooler ocean',
  'hotter daytime extremes': 'cooler daytime extremes',
  'wetter': 'drier',
  'wetter soils': 'drier soils',
  'more humid': 'less humid',
  'windier': 'calmer',
  'greener': 'less green',
  'hazier air': 'clearer air',
  'more polluted air': 'cleaner air',
  'more phytoplankton': 'less phytoplankton',
  'more evaporative demand': 'less evaporative demand',
  'more water leaving the land': 'less water leaving the land',
  'more water returning to the air': 'less water returning to the air',
}

export function lowerMeans(higherMeans: string): string {
  if (OPPOSITE[higherMeans]) return OPPOSITE[higherMeans]
  if (higherMeans.startsWith('more ')) return 'less ' + higherMeans.slice(5)
  return `the opposite of ${higherMeans}`
}

export function plainVerdict(
  s: Summarized, trendUnits: string, higherMeans: string, years: number[],
): string {
  const span = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : ''
  const perDecade = (s.senSlope * 10)
  const dir = perDecade >= 0 ? 'increasing' : 'decreasing'
  const amt = `${Math.abs(perDecade).toFixed(2)} ${trendUnits.replace(' per decade', '')} per decade`

  if (s.label === 'insufficient-data') {
    return `Not enough valid years in ${span} to say anything statistically.`
  }
  const toward = perDecade >= 0 ? higherMeans : lowerMeans(higherMeans)
  if (s.label === 'no-detected-trend') {
    return `Between ${span}, there is no change that stands out from ordinary year-to-year variability (best estimate: ${dir} by about ${amt}, slightly toward ${toward}, but that could easily be noise).`
  }
  const strength = s.mkPAdj < 0.001
    ? 'extremely unlikely to be chance'
    : s.mkPAdj < 0.01
      ? 'very unlikely to be chance'
      : 'unlikely to be chance'
  // direction follows the verdict label, never just the sign of a rounded slope
  const detectedToward = s.label === 'detected-decrease' ? lowerMeans(higherMeans) : higherMeans
  return `Between ${span}, this region is trending toward ${detectedToward} by about ${amt} — ${strength}.`
}

export function plainHorizon(moreYears: number | null, cappedAt: number): string {
  if (moreYears === null) {
    return `At the current rate and noise, this would not become statistically detectable even within ${cappedAt} more years.`
  }
  if (moreYears === 0) return ''
  return `If the current rate and noise continue, roughly ${moreYears} more year${moreYears === 1 ? '' : 's'} of data would be enough to call it.`
}

export const GLOSSARY: Record<string, string> = {
  trend: 'A steady change in one direction over time — the slope says how fast it moves.',
  significant: 'Statistically significant means the pattern is unlikely to have appeared by chance alone. It does not mean the change is large or important — just detectable above the noise.',
  'confidence interval': 'A range of slopes that are all consistent with the data. If the interval excludes zero, the trend is distinguishable from no change.',
  'p-value': 'The probability of seeing a trend at least this strong if the true change were zero. Small p (below 0.05) = surprising under "no change".',
  persistence: 'Years that resemble their neighbours (warm follows warm) make patterns easier to mistake for trends. Tellus corrects for this, which makes its tests harder to fool.',
  "Sen's slope": 'The median of all year-to-year changes — a trend estimate that single odd years cannot drag around.',
  'Mann-Kendall': 'A test that asks whether values systematically rise or fall over time, without assuming anything about the shape of the noise.',
  FDR: 'With 200,000 map cells tested at once, some will look significant by luck. False-discovery-rate correction raises the bar so that only real patterns survive.',
}
