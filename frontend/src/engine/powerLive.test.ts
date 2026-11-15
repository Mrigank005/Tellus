import { describe, expect, it } from 'vitest'
import { tileRequests } from './powerLive'

const spans = (url: string) => {
  const q = new URL(url).searchParams
  return [Number(q.get('latitude-max')) - Number(q.get('latitude-min')),
          Number(q.get('longitude-max')) - Number(q.get('longitude-min'))]
}

describe('live NASA POWER tiling', () => {
  for (const box of [
    { latMin: 23.977777, latMax: 33.977777, lonMin: 48.645177, lonMax: 63.025751 }, // exactly 10 deg lat (was HTTP 422)
    { latMin: 24, latMax: 35, lonMin: 10, lonMax: 21 },                             // 11 deg: old code left a 1 deg sliver
    { latMin: -5, latMax: 40, lonMin: -20, lonMax: 60 },                            // big box
    { latMin: 10, latMax: 10.5, lonMin: 5, lonMax: 5.3 },                           // tiny box gets expanded
  ]) {
    it(`every request stays within POWER's 2..10 degree limits for ${JSON.stringify(box)}`, () => {
      const urls = tileRequests(box, 'T2M')
      expect(urls.length).toBeGreaterThan(0)
      for (const u of urls) for (const s of spans(u)) {
        expect(s).toBeLessThan(10)
        expect(s).toBeGreaterThanOrEqual(2 - 1e-6)
      }
    })
  }
})
