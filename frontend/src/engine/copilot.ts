import type { Selection } from '../state/store'

export interface CopilotClaim {
  text: string
  evidenceType: 'computed_result' | 'project_source' | 'external_source'
  evidenceId: string
  sourceUrl?: string | null
}

export interface CopilotResponse {
  kind: 'answer' | 'analysis_action' | 'clarification' | 'abstain' | 'unavailable'
  message: string
  action?: {
    variableId: string
    regionId: string
    season: string
    windowId: string
  } | null
  claims: CopilotClaim[]
  limitations: string[]
  confidence: 'supported' | 'needs-context' | 'abstain' | 'unavailable'
}

const API_BASE = (import.meta.env.VITE_COPILOT_API_URL as string | undefined) ?? 'http://localhost:8000'

export async function askCopilot(message: string, selection: Selection): Promise<CopilotResponse> {
  const res = await fetch(`${API_BASE}/api/copilot/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      selection: {
        variableId: selection.variableId,
        regionId: selection.regionId,
        season: selection.season,
        windowId: selection.windowId,
      },
    }),
  })
  if (!res.ok) {
    throw new Error(`Copilot service returned HTTP ${res.status}`)
  }
  return await res.json() as CopilotResponse
}
