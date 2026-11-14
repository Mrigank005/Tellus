/**
 * Exploratory anomaly diagnostics - served from a STATIC precomputed asset
 * (data/anomalies.json, built by pipeline/build_assets.py stage_anomalies).
 * The backend endpoint duplicates this for the copilot's evidence tools; the
 * workspace itself never needs a server.
 */

export type AnomalyEvent = {
  year: number
  value: number
  score: number
  kind: string
}

export type ChangePoint = {
  year: number
  meanBefore: number
  meanAfter: number
  score: number
  kind: string
}

export type StaticAnomalies = {
  anomalies: AnomalyEvent[]
  changePoints: ChangePoint[]
}

type StaticDoc = Record<string, Record<string, Record<string, Record<string, StaticAnomalies>>>>

export type AnomalyResult = StaticAnomalies & {
  evidenceId: string
  exploratory: true
  limitations: string[]
}

let cache: StaticDoc | null = null

async function loadDoc(): Promise<StaticDoc> {
  if (cache) return cache
  const res = await fetch('./data/anomalies.json')
  if (!res.ok) throw new Error(`Anomaly asset unavailable (HTTP ${res.status}).`)
  cache = await res.json() as StaticDoc
  return cache
}

export async function loadAnomalies(
  variableId: string,
  regionId: string,
  season: string,
  windowId: string,
): Promise<AnomalyResult> {
  const doc = await loadDoc()
  const entry = doc[variableId]?.[season]?.[regionId]?.[windowId]
  if (!entry) throw new Error('No diagnostics for this combination.')
  return {
    ...entry,
    evidenceId: `anomalies:${variableId}:${regionId}:${season}:${windowId}`,
    exploratory: true,
    limitations: [
      'Candidate events are diagnostic flags, not statistically significant climate findings.',
      'Interpret results alongside the authoritative trend analysis.',
    ],
  }
}
