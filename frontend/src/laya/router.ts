/**
 * Laya — transparent rules-based question router.
 * Maps natural-language questions onto supported investigations. Laya always
 * explains its choice, and abstains on anything outside the supported scope
 * (no causality, no forecasting, no groundwater claims, no invented datasets).
 */
import type { Catalog } from '../engine/loader'

export interface LayaAnswer {
  kind: 'recommend' | 'abstain'
  text: string
  variableId?: string
  season?: string
  regionId?: string
}

interface Rule {
  keys: RegExp
  variableId: string
  season?: string
  explain: string
  warn?: string
}

const RULES: Rule[] = [
  // NOTE: specific rules must precede general ones — "nights getting warmer"
  // must hit night minimum, not mean temperature; "more humid" must hit
  // humidity, not the drought rule.
  {
    keys: /night|nighttime|minimum temp|frost/i,
    variableId: 'T2M_MIN', season: 'annual',
    explain: 'Nighttime minimum temperature tells you how nights specifically are changing.',
  },
  {
    keys: /day( ?time)? max|hottest days|extreme heat|heat ?waves?/i,
    variableId: 'T2M_MAX', season: 'annual',
    explain: 'Daytime maximum temperature tracks how hot the hottest days are getting.',
  },
  {
    keys: /humidit|humid|moist air|mugg/i,
    variableId: 'RH2M', season: 'annual',
    explain: 'Relative humidity at 2 m measures how close the air is to saturation.',
  },
  {
    keys: /monsoon|rain|precip|wet season|JJAS/i,
    variableId: 'PRECTOTCORR', season: 'JJAS',
    explain: 'June–September precipitation — the core of the South Asian monsoon — is the most watched rainfall window there; elsewhere it is simply the Jun–Sep season.',
  },
  {
    keys: /dr(y|ying|ier|iest)|drought|arid/i,
    variableId: 'GWETTOP', season: 'annual',
    explain: 'Surface soil wetness (0–1, land-model estimate) is a starting point for drying questions — but drought needs several variables together.',
    warn: 'No single variable establishes drought. Combine precipitation, soil wetness and evaporation, and treat model estimates with caution.',
  },
  {
    keys: /evaporat|water loss/i,
    variableId: 'EVLAND', season: 'annual',
    explain: 'Evaporation over land measures how much water leaves the surface into the air.',
  },
  {
    keys: /wind|breeze/i,
    variableId: 'WS10M', season: 'annual',
    explain: 'Wind speed at 10 m is the standard near-surface wind measure.',
  },
  {
    keys: /hotter|warm|heat|temperature|cool(ing)?\b|cold/i,
    variableId: 'T2M', season: 'annual',
    explain: 'Near-surface air temperature (2 m, MERRA-2-based) directly measures warming and cooling.',
  },
]

const REGION_HINTS: { keys: RegExp; regionId: string }[] = [
  { keys: /whole earth|entire (?:planet|earth)|global mean|world ?wide|everywhere|the planet/i, regionId: 'whole-earth' },
  { keys: /arctic|north pole|polar/i, regionId: 'arctic' },
  { keys: /antarctic|south pole|antarctica/i, regionId: 'antarctica' },
  { keys: /greenland/i, regionId: 'greenland' },
  { keys: /siberia|russia|taiga/i, regionId: 'siberia' },
  { keys: /europe|germany|france|spain/i, regionId: 'western-europe' },
  { keys: /sahara|north africa/i, regionId: 'sahara' },
  { keys: /sahel/i, regionId: 'sahel' },
  { keys: /congo|central africa/i, regionId: 'congo-basin' },
  { keys: /amazon|brazil|rainforest/i, regionId: 'amazon' },
  { keys: /andes|patagonia|peru|chile/i, regionId: 'andes' },
  { keys: /great plains|midwest|united states|usa\b/i, regionId: 'us-great-plains' },
  { keys: /tropics?|equator/i, regionId: 'tropics' },
  { keys: /indonesia|maritime southeast|philippines/i, regionId: 'maritime-southeast-asia' },
  { keys: /australia|outback/i, regionId: 'australian-outback' },
  { keys: /himalaya|karakoram|tibet/i, regionId: 'himalaya' },
  { keys: /gangetic|plains? of india|punjab|ganges/i, regionId: 'indo-gangetic-plain' },
  { keys: /ghats|kerala|konkan|malabar/i, regionId: 'western-ghats' },
  { keys: /thar|rajasthan/i, regionId: 'thar-northwest' },
  { keys: /bengal|bangladesh|delta/i, regionId: 'bengal-delta' },
]

const ABSTENTIONS: { keys: RegExp; text: string }[] = [
  {
    keys: /why (is|do|does|are)|what caused|caused by|reason for|attribut/i,
    text: "I don't infer causes. Tellus shows what is changing, where, how fast, and whether the trend is statistically significant — the causes need scientific study beyond this tool.",
  },
  {
    keys: /forecast|predict|projection|will (it|this|there) .*(2050|2100)|in the (next|future)|next (year|decade)|by 2050|by 2100/i,
    text: "I don't forecast. The tool analyses the observed record; projecting the future needs climate models, which is outside Tellus's scope.",
  },
  {
    keys: /groundwater|water table|aquifer/i,
    text: "Groundwater isn't in Tellus's variable set (that needs GRACE-style data). Surface soil wetness is the closest supported variable, and it is a model estimate.",
  },
]

export function layaAnswer(question: string, catalog: Catalog): LayaAnswer {
  const q = question.trim()
  if (q.length < 3) return { kind: 'abstain', text: 'Ask me a question about what might be changing — for example: “Is the Himalaya getting warmer?”' }

  for (const a of ABSTENTIONS) {
    if (a.keys.test(q)) return { kind: 'abstain', text: a.text }
  }

  const rule = RULES.find((r) => r.keys.test(q))
  if (!rule) {
    return {
      kind: 'abstain',
      text: `I can only route questions to Tellus's supported variables: ${catalog.variables.map((v) => v.short_name.toLowerCase()).join(', ')}. Try rephrasing with one of those, like “Is monsoon rainfall changing in the Western Ghats?”`,
    }
  }

  const region = REGION_HINTS.find((r) => r.keys.test(q))
  let text = `Let's investigate with **${rule.variableId}**${rule.season === 'JJAS' ? ' (monsoon season)' : ''}${region ? ` over the **${catalog.regions.find((r) => r.id === region.regionId)?.name ?? region.regionId}** region` : ''}. ${rule.explain}`
  if (rule.warn) text += ` ⚠ ${rule.warn}`
  return {
    kind: 'recommend',
    text,
    variableId: rule.variableId,
    season: rule.season,
    regionId: region?.regionId,
  }
}
