import { describe, expect, it } from 'vitest'
import { lowerMeans, plainVerdict } from './explain'
import type { Summarized } from './stats'

const base = { n: 45, mkPAdj: 0.001, label: 'detected-decrease' } as unknown as Summarized
const years = Array.from({ length: 45 }, (_, i) => 1981 + i)

describe('plain-language verdict direction', () => {
  it('a detected decrease never reads "toward" the higher-value word', () => {
    const s = { ...base, senSlope: -0.02 } as Summarized
    const text = plainVerdict(s, '°C per decade', 'warmer', years)
    expect(text).toContain('toward cooler')
    expect(text).not.toContain('toward warmer')
  })
  it('a detected increase uses the higher-value word', () => {
    const s = { ...base, label: 'detected-increase', senSlope: 0.02 } as Summarized
    expect(plainVerdict(s, '°C per decade', 'warmer', years)).toContain('toward warmer')
  })
  it('every catalogue phrase has a real opposite', () => {
    for (const w of ['greener', 'hazier air', 'windier', 'wetter soils', 'more polluted air', 'more humid']) {
      expect(lowerMeans(w)).not.toContain('opposite of')
      expect(lowerMeans(w)).not.toBe(w)
    }
  })
})
