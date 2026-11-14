/**
 * Do two regions share ground? Used by the two-region difference test, which
 * assumes the two regional series are independent: if one region contains or
 * overlaps the other (e.g. "Whole Earth" vs anything, "Tropics" vs "Amazon")
 * the samples share data and the result is only approximate.
 *
 * Overlap is judged on polygon bounding boxes: conservative (a diagonal
 * polygon may be flagged although its true shapes only touch) but never
 * misses a real overlap.
 */
export interface Box { lonMin: number; lonMax: number; latMin: number; latMax: number }

export type RegionRelation = 'separate' | 'overlap' | 'a-contains-b' | 'b-contains-a' | 'same'

export function polygonBox(polygon: number[][]): Box {
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity
  for (const [lo, la] of polygon) {
    lonMin = Math.min(lonMin, lo); lonMax = Math.max(lonMax, lo)
    latMin = Math.min(latMin, la); latMax = Math.max(latMax, la)
  }
  return { lonMin, lonMax, latMin, latMax }
}

const contains = (o: Box, i: Box) =>
  o.lonMin <= i.lonMin && o.lonMax >= i.lonMax && o.latMin <= i.latMin && o.latMax >= i.latMax

/** Relationship between two regions; boxes that only touch along an edge
 * count as separate. */
export function regionRelation(a: number[][], b: number[][]): RegionRelation {
  const A = polygonBox(a), B = polygonBox(b)
  const lonOverlap = Math.min(A.lonMax, B.lonMax) - Math.max(A.lonMin, B.lonMin)
  const latOverlap = Math.min(A.latMax, B.latMax) - Math.max(A.latMin, B.latMin)
  if (!(lonOverlap > 0 && latOverlap > 0)) return 'separate'
  const ab = contains(A, B), ba = contains(B, A)
  if (ab && ba) return 'same'
  if (ab) return 'a-contains-b'
  if (ba) return 'b-contains-a'
  return 'overlap'
}

export const regionsOverlap = (a: number[][], b: number[][]) =>
  regionRelation(a, b) !== 'separate'
