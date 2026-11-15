import { describe, expect, it } from 'vitest'
import { areaFractionsByCategory } from './geography'

describe('areaFractionsByCategory', () => {
  it('counts flagged cells in their base category, so the fractions sum to 1', () => {
    // equator row only (cos = 1): increase, increase+caution, no-trend+naive-only, no-trend+both flags
    const labels = new Uint8Array([0, 0x80 | 0, 0x40 | 2, 0xc0 | 2])
    const out = areaFractionsByCategory(labels, new Float64Array([0]), new Float64Array([0, 1, 2, 3]))
    expect(out['detected-increase']).toBeCloseTo(0.5)
    expect(out['no-detected-trend']).toBeCloseTo(0.5)
    const total = Object.values(out).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1)
  })
})
