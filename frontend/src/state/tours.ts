import { useStore } from './store'

export interface TourStep {
  caption: string
  /** store mutation to apply when the step begins */
  apply?: () => void
}

export interface Tour {
  id: string
  title: string
  steps: TourStep[]
}

const set = useStore.setState

export const TOURS: Record<string, Tour> = {
  'polar-express': {
    id: 'polar-express',
    title: 'The Polar Express — is the Arctic really warming faster?',
    steps: [
      {
        caption: 'This is the evidence workspace. The map shows 207,936 NASA grid cells, each coloured by its temperature trend — red warming, blue cooling. Faded cells are not statistically significant.',
        apply: () => set({
          variableId: 'T2M', season: 'annual', windowId: 'full',
          regionId: 'arctic', compareRegionId: 'tropics', customPolygon: null,
        }),
      },
      {
        caption: 'The verdict card answers in plain language first — and the statistics live behind "Show the statistics". Note +0.46 °C per decade in the Arctic.',
      },
      {
        caption: 'The A/B comparison is the point: the Arctic warms about 2.4× faster than the tropics. Same planet, same variable, different places — exactly how Earth works.',
      },
      {
        caption: 'Now stress-test it: switch to the last 20 years. A weaker record can turn a real trend into "not detected yet" — honest tools tell you that instead of guessing.',
        apply: () => set({ windowId: 'w20' }),
      },
      {
        caption: 'Switch back to the full record to see the trend return.',
        apply: () => set({ windowId: 'full' }),
      },
      {
        caption: 'Your turn: pick any region, draw your own with two clicks on the map, and read the verdict for yourself. The evidence export button saves everything you found.',
      },
    ],
  },
  'monsoon-shift': {
    id: 'monsoon-shift',
    title: 'Model vs satellite — who do you trust?',
    steps: [
      {
        caption: 'This is the Western Ghats, the mountains that intercept the Indian monsoon. The verdict says rainfall is increasing… according to the model.',
        apply: () => set({
          variableId: 'PRECTOTCORR', season: 'JJAS', windowId: 'full',
          regionId: 'western-ghats', compareRegionId: null, customPolygon: null,
        }),
      },
      {
        caption: 'Open the "Time series" tab below the map — the Model vs observed panel compares MERRA-2 (blue) with what satellites and rain gauges actually measured (green).',
      },
      {
        caption: 'They disagree: the model says +136 mm per decade; observations say about −5. When that happens, the observed record is the reference for "what fell".',
      },
      {
        caption: 'Tellus flags the disagreement loudly instead of hiding it — that is what being a data detective means. Every claim in this app can be checked, and exported.',
      },
    ],
  },
}
