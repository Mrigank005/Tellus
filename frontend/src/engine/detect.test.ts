import { describe, expect, it } from 'vitest'
import { detectionHorizon, residualSd } from './detect'

describe('detectionHorizon', () => {
  it('needs few extra years for a strong clean trend', () => {
    // slope 0.05/yr, sd 0.1, no persistence: detectable well within current n
    const h = detectionHorizon(20, 0.05, 0.1, 0)
    expect(h.moreYears).not.toBeNull()
    expect(h.moreYears! <= 5).toBe(true)
  })
  it('needs more years under persistence', () => {
    const noisefree = detectionHorizon(20, 0.02, 0.3, 0)
    const persistent = detectionHorizon(20, 0.02, 0.3, 0.6)
    expect(persistent.moreYears ?? 99).toBeGreaterThanOrEqual(noisefree.moreYears ?? 99)
  })
  it('returns null when even 50 more years would not do', () => {
    const h = detectionHorizon(45, 0.0001, 1.0, 0.6)
    expect(h.moreYears).toBeNull()
  })
  it('residualSd measures noise around a fit', () => {
    const y = Array.from({ length: 40 }, (_, i) => 0.1 * i + (i % 2 ? 0.5 : -0.5))
    expect(residualSd(y)).toBeCloseTo(0.5, 1)
  })
})
