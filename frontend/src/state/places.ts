/**
 * One voice for places, spans and seasons in every sentence Tellus writes
 * (the journey's Ask sentence and verdict title, Set up your question, the field desk bar).
 */

/** How a place reads in the middle of a sentence. */
const MID: Record<string, string> = {
  'whole-earth': 'the whole Earth', 'southern-ocean': 'the Southern Ocean', nino34: 'the Niño 3.4 region',
  arctic: 'the Arctic', antarctica: 'Antarctica', greenland: 'Greenland', siberia: 'Siberia',
  'western-europe': 'western Europe', sahara: 'the Sahara', sahel: 'the Sahel', 'congo-basin': 'the Congo Basin',
  amazon: 'the Amazon', andes: 'the Andes', 'us-great-plains': 'the US Great Plains', tropics: 'the tropics',
  'maritime-southeast-asia': 'maritime Southeast Asia', 'australian-outback': 'the Australian outback',
  himalaya: 'the Himalaya', 'indo-gangetic-plain': 'the Indo-Gangetic Plain', 'western-ghats': 'the Western Ghats',
  'thar-northwest': 'the Thar Desert', 'bengal-delta': 'the Bengal Delta',
}

/** Places whose names take a plural verb ("the Andes are", "Are the tropics"). */
const PLURAL = new Set(['andes', 'us-great-plains', 'tropics', 'western-ghats'])

export interface Place {
  /** middle of a sentence: "the Arctic" */
  mid: string
  /** start of a sentence: "The Arctic" */
  title: string
  /** "is" or "are" */
  is: string
  /** question opener: "Is" or "Are" */
  Is: string
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** `fallbackName` is the catalog name, used for any region not listed above. */
export function place(regionId: string, fallbackName?: string): Place {
  if (regionId === 'custom') return { mid: 'the region you drew', title: 'The region you drew', is: 'is', Is: 'Is' }
  let mid = MID[regionId]
  if (!mid) {
    const n = fallbackName ?? 'this region'
    mid = /^the /i.test(n) ? `the ${n.slice(4)}` : n
  }
  const plural = PLURAL.has(regionId)
  return { mid, title: cap(mid), is: plural ? 'are' : 'is', Is: plural ? 'Are' : 'Is' }
}

/** "the last 45 years" for a catalog window. */
export function spanPhrase(w: { start: number; end: number } | undefined | null): string {
  return w ? `the last ${w.end - w.start + 1} years` : 'the full record'
}

/** "all year", "in June to September", "in December to February". */
export function seasonPhrase(id: string, label?: string): string {
  if (id === 'annual') return 'all year'
  if (id === 'JJAS') return 'in June to September'
  if (id === 'DJF') return 'in December to February'
  return `in ${(label ?? id).split(' (')[0]}`
}
