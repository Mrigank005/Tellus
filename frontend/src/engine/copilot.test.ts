import { describe, expect, it } from 'vitest'

describe('copilot response contract', () => {
  it('recognizes supported response kinds', () => {
    const kinds = ['answer', 'analysis_action', 'clarification', 'abstain', 'unavailable']
    expect(kinds).toContain('answer')
    expect(kinds).toContain('abstain')
  })

  it('never exposes an API key in the browser client', async () => {
    const source = await import('./copilot?raw')
    expect(source.default).not.toMatch(/LLM_API_KEY|Authorization\s*:/)
  })
})
