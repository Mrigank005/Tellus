import { create } from 'zustand'
import type { Polygon } from '../engine/geography'

export type Screen = 'start' | 'configure' | 'workspace' | 'library' | 'check'
export type Mode = 'place' | 'variable'

export interface Selection {
  screen: Screen
  mode: Mode
  variableId: string
  season: string
  windowId: string
  regionId: string
  customPolygon: Polygon | null
  compareRegionId: string | null
  drawing: boolean
  tourId: string | null
}

interface Store extends Selection {
  go: (screen: Screen) => void
  setMode: (mode: Mode) => void
  setVariable: (id: string) => void
  setSeason: (s: string) => void
  setWindow: (w: string) => void
  setRegion: (id: string, custom?: Polygon | null) => void
  setCompare: (id: string | null) => void
  setDrawing: (d: boolean) => void
  setTour: (id: string | null) => void
  applyLaya: (patch: Partial<Selection>) => void
}

export const useStore = create<Store>((set) => ({
  screen: 'start',
  mode: 'place',
  variableId: 'T2M',
  season: 'annual',
  windowId: 'full',
  regionId: 'arctic',
  customPolygon: null,
  compareRegionId: null,
  drawing: false,
  tourId: null,
  go: (screen) => set({ screen }),
  setMode: (mode) => set({ mode }),
  setVariable: (variableId) => set({ variableId }),
  setSeason: (season) => set({ season }),
  setWindow: (windowId) => set({ windowId }),
  setRegion: (regionId, custom = null) =>
    set({ regionId, customPolygon: regionId === 'custom' ? custom : null }),
  setCompare: (compareRegionId) => set({ compareRegionId }),
  setDrawing: (drawing) => set({ drawing }),
  setTour: (tourId) => set({ tourId }),
  applyLaya: (patch) => set(patch),
}))

export interface DetectiveCase {
  id: string
  title: string
  question: string
  variableId: string
  season: string
  windowId: string
  regionId: string
  compareRegionId?: string | null
  blurb: string
}

export const DETECTIVE_CASES: DetectiveCase[] = [
  {
    id: 'polar-amplification',
    title: 'The Polar Express',
    question: 'Is the Arctic really warming faster than the tropics?',
    variableId: 'T2M',
    season: 'annual',
    windowId: 'full',
    regionId: 'arctic',
    compareRegionId: 'tropics',
    blurb: 'Scientists call it Arctic amplification: the far north warms several times faster than the global mean. Test the claim yourself with 45 years of NASA data.',
  },
  {
    id: 'himalaya-warming',
    title: 'The Mountain Thermometer',
    question: 'Is the Himalaya warming faster than the plains?',
    variableId: 'T2M',
    season: 'annual',
    windowId: 'full',
    regionId: 'himalaya',
    compareRegionId: 'indo-gangetic-plain',
    blurb: 'High mountains are called the "third pole". Compare Himalayan warming with the Indo-Gangetic Plain — the same planet, very different signals.',
  },
  {
    id: 'monsoon-shift',
    title: 'The Monsoon Question',
    question: 'Is monsoon rainfall changing over the Western Ghats?',
    variableId: 'PRECTOTCORR',
    season: 'JJAS',
    windowId: 'full',
    regionId: 'western-ghats',
    blurb: 'The Ghats intercept the monsoon every June–September. Check the model trend, then hold it against the observed GPCP record in the cross-check panel.',
  },
  {
    id: 'night-day',
    title: 'Nights vs Days',
    question: 'Are nights warming faster than days?',
    variableId: 'T2M_MIN',
    season: 'annual',
    windowId: 'full',
    regionId: 'indo-gangetic-plain',
    compareRegionId: null,
    blurb: 'Run this case, then switch the variable to Daytime max temperature and compare. Where do nights heat faster — and does it matter for people?',
  },
]
