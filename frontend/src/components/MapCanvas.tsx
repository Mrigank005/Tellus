import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map as MLMap } from 'maplibre-gl'
import type { Grid, TrendPack } from '../engine/loader'
import type { Polygon } from '../engine/geography'
import type { RegionVerdict } from '../engine/missions'
import { useTheme, type Theme } from '../state/theme'
import { prefersReducedMotion, scaleColor, tokens } from '../styles/tokens'

export interface MapHover {
  lon: number
  lat: number
  pixelIdx: number
  /** pointer position inside the map, and the map size, so a tooltip can follow the pointer */
  x?: number
  y?: number
  w?: number
  h?: number
}

export interface MapCanvasProps {
  grid: Grid
  domain: { lon_min: number; lon_max: number; lat_min: number; lat_max: number }
  trends: TrendPack | null
  showSignificance: boolean
  regionA: Polygon | null
  regionB: Polygon | null
  drawing: boolean
  onDrawn: (polygon: Polygon) => void
  onHover: (info: MapHover | null) => void
  trendUnits: string
  regionVerdicts?: RegionVerdict[] | null
}

const UPSCALE = 4
const HATCH_IMAGE = 'tellus-hatch'

// ---------------------------------------------------------------------------
// colour helpers (the map paints its own pixels, so it reads tokens.ts)
// ---------------------------------------------------------------------------
type RGB = [number, number, number]
const rgbCache = new Map<string, RGB>()
function rgb(hex: string): RGB {
  let c = rgbCache.get(hex)
  if (!c) {
    const h = hex.replace('#', '')
    c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    rgbCache.set(hex, c)
  }
  return c
}
/** `a` blended toward `b` by `t` (0..1). */
function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

// ---------------------------------------------------------------------------
// style: a paper basemap. Local coastline always; vector tiles (borders and
// labels only) are a bonus that simply stays empty when offline.
// ---------------------------------------------------------------------------
function buildStyle(theme: Theme) {
  const t = tokens(theme)
  const labelFont = ['Noto Sans Regular']
  const place = ['coalesce', ['get', 'name_en'], ['get', 'name']]
  return {
    version: 8 as const,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      'es-coast': { type: 'geojson' as const, data: './coastline.json' },
      openmaptiles: { type: 'vector' as const, url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': t.paper } },
      { id: 'water', type: 'fill' as const, source: 'openmaptiles', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': t.paperSunk } },
      { id: 'boundary-line', type: 'line' as const, source: 'openmaptiles', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': t.ink, 'line-opacity': 0.28, 'line-width': 0.7 } },
      { id: 'coast-detail-line', type: 'line' as const, source: 'openmaptiles', 'source-layer': 'water',
        minzoom: 4.5, filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': t.ink, 'line-opacity': 0.5, 'line-width': 0.8 } },
      { id: 'es-coast-line', type: 'line' as const, source: 'es-coast', maxzoom: 4.5,
        paint: { 'line-color': t.ink, 'line-opacity': 0.5, 'line-width': 0.9 } },
      { id: 'label-ocean', type: 'symbol' as const, source: 'openmaptiles', 'source-layer': 'water_name',
        filter: ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
        layout: { 'text-field': place, 'text-font': ['Noto Sans Italic'], 'text-size': 12,
          'text-letter-spacing': 0.15, 'text-max-width': 6 },
        paint: { 'text-color': t.inkSoft, 'text-opacity': 0.85, 'text-halo-color': t.paper, 'text-halo-width': 1.5 } },
      { id: 'label-country', type: 'symbol' as const, source: 'openmaptiles', 'source-layer': 'place',
        maxzoom: 8, filter: ['==', ['get', 'class'], 'country'],
        layout: { 'text-field': place, 'text-font': labelFont, 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 13],
          'text-max-width': 6, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
        paint: { 'text-color': t.ink, 'text-opacity': 0.72, 'text-halo-color': t.paper, 'text-halo-width': 1.5 } },
    ],
  }
}

/** Stacking order, bottom to top. Lines and labels sit above the raster so
 * geography stays readable; the outlines the reader cares about sit on top. */
const LAYER_ORDER = [
  'region-verdicts-fill', 'region-verdicts-hatch',
  'trend-layer',
  'boundary-line', 'coast-detail-line', 'es-coast-line', 'label-ocean', 'label-country',
  'region-verdicts-line',
  'region-a-fill', 'region-a-casing', 'region-a-line',
  'region-b-fill', 'region-b-casing', 'region-b-line',
  'draw-preview-line',
]
function enforceLayerOrder(map: MLMap) {
  for (const id of LAYER_ORDER) if (map.getLayer(id)) map.moveLayer(id)
}

/** 8x8 diagonal hatch tile, used as a fill pattern for "no trend detected" regions. */
function hatchImage(theme: Theme) {
  const [r, g, b] = rgb(tokens(theme).ink)
  const size = 8
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + y) % size === 0) {
        const o = (y * size + x) * 4
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 120
      }
    }
  }
  return { width: size, height: size, data }
}

function verdictFill(theme: Theme) {
  const t = tokens(theme)
  const inc = scaleColor(1, 1, theme) ?? t.ember
  const dec = scaleColor(-1, 1, theme) ?? t.tide
  return ['match', ['get', 'label'],
    'detected-increase', inc,
    'detected-decrease', dec,
    'no-detected-trend', t.paperSunk,
    'rgba(0,0,0,0)'] as never
}

/** Re-colour every themed layer in place (no map rebuild). */
function applyTheme(map: MLMap, theme: Theme) {
  const t = tokens(theme)
  const set = (layer: string, prop: string, value: unknown) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value as never)
  }
  set('bg', 'background-color', t.paper)
  set('water', 'fill-color', t.paperSunk)
  set('boundary-line', 'line-color', t.ink)
  set('coast-detail-line', 'line-color', t.ink)
  set('es-coast-line', 'line-color', t.ink)
  for (const id of ['label-ocean', 'label-country']) {
    set(id, 'text-color', id === 'label-ocean' ? t.inkSoft : t.ink)
    set(id, 'text-halo-color', t.paper)
  }
  for (const [id, color] of [['region-a', t.copper], ['region-b', t.leaf]] as const) {
    set(`${id}-fill`, 'fill-color', color)
    set(`${id}-line`, 'line-color', color)
    set(`${id}-casing`, 'line-color', t.paper)
  }
  set('draw-preview-line', 'line-color', t.leaf)
  set('region-verdicts-fill', 'fill-color', verdictFill(theme))
  set('region-verdicts-line', 'line-color', t.ink)
  if (map.hasImage(HATCH_IMAGE)) map.updateImage(HATCH_IMAGE, hatchImage(theme))
}

/** 98th percentile of |slope| so one extreme cell cannot wash out the map. */
export function slopeVmax(slopes: Float32Array): number {
  const vals: number[] = []
  for (let i = 0; i < slopes.length; i++) {
    const v = Math.abs(slopes[i])
    if (Number.isFinite(v)) vals.push(v)
  }
  if (!vals.length) return 1
  vals.sort((a, b) => a - b)
  return vals[Math.floor(vals.length * 0.98)] || vals[vals.length - 1]
}

export default function MapCanvas(props: MapCanvasProps) {
  const { grid, domain, trends, showSignificance, regionA, regionB, drawing, onDrawn, onHover, regionVerdicts } = props
  const theme = useTheme((s) => s.theme)
  const mapRef = useRef<MLMap | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trendUrlRef = useRef<string | null>(null)
  const [styleReady, setStyleReady] = useState(false)
  const drawState = useRef<{ start: [number, number] | null; cur: [number, number] | null; anchor: [number, number] | null }>({ start: null, cur: null, anchor: null })
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // latest values for handlers registered once at map creation
  const live = useRef({ grid, drawing, onHover, theme })
  live.current = { grid, drawing, onHover, theme }

  // ---- init map once -----------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const narrow = containerRef.current.clientWidth < 700
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(live.current.theme) as never,
      center: [20, 20],
      zoom: narrow ? 1 : 1.6,
      minZoom: 1,
      maxZoom: 8,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    ;(window as unknown as { __esMap?: MLMap }).__esMap = map // diagnostics handle
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // Ready as soon as the style (with its sources) exists, never depend on
    // tile servers answering, or the overlays would not appear on a weak network.
    map.on('styledata', () => {
      const srcs = Object.keys(map.getStyle()?.sources ?? {})
      if (srcs.length > 0) setStyleReady(true)
    })
    map.on('error', () => { /* offline: the local coastline still draws; borders and labels stay empty */ })
    map.on('mousemove', (e) => handleHover(e))
    map.on('mouseout', () => live.current.onHover(null))
    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- theme: repaint layers in place --------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    applyTheme(map, theme)
  }, [theme, styleReady])

  // ---- region-verdict layer for variables without a per-pixel map --------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady || !regionVerdicts) return
    if (!map.getSource('region-verdicts')) {
      const t = tokens(live.current.theme)
      if (!map.hasImage(HATCH_IMAGE)) map.addImage(HATCH_IMAGE, hatchImage(live.current.theme))
      map.addSource('region-verdicts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'region-verdicts-fill', type: 'fill', source: 'region-verdicts',
        paint: { 'fill-color': verdictFill(live.current.theme), 'fill-opacity': 0.82 },
      })
      map.addLayer({
        id: 'region-verdicts-hatch', type: 'fill', source: 'region-verdicts',
        filter: ['in', ['get', 'label'], ['literal', ['no-detected-trend', 'insufficient-data']]],
        paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': 0.55 },
      })
      map.addLayer({
        id: 'region-verdicts-line', type: 'line', source: 'region-verdicts',
        paint: { 'line-color': t.ink, 'line-width': 1, 'line-opacity': 0.55 },
      })
    }
    const src = map.getSource('region-verdicts') as maplibregl.GeoJSONSource
    src.setData({
      type: 'FeatureCollection',
      features: regionVerdicts.map((v) => ({
        type: 'Feature' as const,
        properties: { label: v.label, name: v.name },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[...v.polygon, v.polygon[0]]],
        },
      })),
    })
    enforceLayerOrder(map)
  }, [regionVerdicts, styleReady])

  // ---- trend raster, painted with the data scale ---------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady || !trends || !grid.lats.length) return

    const t = tokens(theme)
    const nLat = grid.lats.length, nLon = grid.lons.length
    const slopes = trends.slope
    const vmax = Math.max(slopeVmax(slopes), 1e-9)
    const paper = rgb(t.paper)
    const sun = rgb(t.sun)
    const wash = rgb(t.ink)

    // one RGBA value per grid cell (little-endian packed), row i = latitude index
    const cells = new Uint32Array(nLat * nLon)
    const pack = (c: RGB, a: number) => ((a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) {
        const p = i * nLon + j
        const code = trends.label[p] & 0x3f
        const hex = (code === 3 || !Number.isFinite(slopes[p])) ? null : scaleColor(slopes[p], vmax, theme)
        if (!hex) {
          // too little data: a faint ink wash, no hue
          cells[p] = pack(wash, 34)
          continue
        }
        const significant = code === 0 || code === 1
        const naiveOnly = (trends.label[p] & 0x40) !== 0 && !significant
        let c = rgb(hex)
        let a = 232
        if (showSignificance && !significant) {
          if (naiveOnly) {
            // the naive test called it significant, persistence adjustment removed it:
            // blend toward sun so it reads as "almost, but not after correction"
            c = mix(c, sun, 0.42); a = 205
          } else {
            // not detected: faded. On Day paper, blend the hue toward paper; on Dusk,
            // blending toward dark paper would make these the darkest, loudest cells,
            // so keep the hue and lower its opacity instead.
            if (theme === 'dusk') a = 168
            else { c = mix(c, paper, 0.6); a = 150 }
          }
        }
        cells[p] = pack(c, a)
      }
    }

    // MapLibre places an image linearly in Web Mercator, and Mercator stops at
    // +-85.05 degrees, so resample the cell grid into a Mercator-square image:
    // every pixel takes the colour of the cell under it (honest, crisp cells).
    const lonMin = domain.lon_min, lonMax = domain.lon_max
    const W = nLon * UPSCALE, H = W
    const lon0 = grid.lons[0], lon1 = grid.lons[nLon - 1]
    const lat0 = grid.lats[0], lat1 = grid.lats[nLat - 1]
    const dLon = (lon1 - lon0) / (nLon - 1), dLat = (lat1 - lat0) / (nLat - 1)
    const colIdx = new Uint16Array(W)
    for (let x = 0; x < W; x++) {
      const lon = lonMin + ((x + 0.5) / W) * (lonMax - lonMin)
      colIdx[x] = Math.max(0, Math.min(nLon - 1, Math.round((lon - lon0) / dLon)))
    }
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas')
    const big = canvasRef.current
    big.width = W; big.height = H
    const bctx = big.getContext('2d')!
    const out = bctx.createImageData(W, H)
    const out32 = new Uint32Array(out.data.buffer)
    for (let y = 0; y < H; y++) {
      const merc = Math.PI * (1 - (2 * (y + 0.5)) / H)
      const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI
      const i = Math.max(0, Math.min(nLat - 1, Math.round((lat - lat0) / dLat)))
      const row = i * nLon
      const o = y * W
      for (let x = 0; x < W; x++) out32[o + x] = cells[row + colIdx[x]]
    }
    bctx.putImageData(out, 0, 0)
    const url = big.toDataURL()

    const latTop = 85.0511287798
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [lonMin, latTop], [lonMax, latTop], [lonMax, -latTop], [lonMin, -latTop],
    ]
    const src = map.getSource('trend') as maplibregl.ImageSource | undefined
    if (src) {
      src.updateImage({ url, coordinates: coords })
    } else {
      map.addSource('trend', { type: 'image', url, coordinates: coords })
      map.addLayer({
        id: 'trend-layer', type: 'raster', source: 'trend',
        paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
      })
    }
    enforceLayerOrder(map)
    trendUrlRef.current = url
  }, [trends, styleReady, grid, domain, showSignificance, theme])

  // ---- region layers -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const t = tokens(live.current.theme)
    const ensure = (id: string, color: string, dash?: number[]) => {
      if (!map.getSource(id)) {
        map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: `${id}-fill`, type: 'fill', source: id,
          paint: { 'fill-color': color, 'fill-opacity': 0.1 },
        })
        // paper casing keeps the outline legible on dark and saturated cells
        map.addLayer({
          id: `${id}-casing`, type: 'line', source: id,
          paint: { 'line-color': t.paper, 'line-width': 5, 'line-opacity': 0.6 },
        })
        map.addLayer({
          id: `${id}-line`, type: 'line', source: id,
          paint: dash
            ? { 'line-color': color, 'line-width': 2.5, 'line-dasharray': dash }
            : { 'line-color': color, 'line-width': 2.5 },
        })
      }
    }
    ensure('region-a', t.copper)
    ensure('region-b', t.leaf, [3, 1.5])
    const set = (id: string, poly: Polygon | null) => {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (!src) return
      src.setData(poly ? {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...poly, poly[0]]] } }],
      } : { type: 'FeatureCollection', features: [] })
    }
    set('region-a', regionA)
    set('region-b', regionB)
    enforceLayerOrder(map)
  }, [regionA, regionB, styleReady])

  // ---- bring the chosen place(s) into view ---------------------------------
  // keyed on the coordinates, so re-renders with an equal polygon do not move the map
  const fitKey = JSON.stringify([regionA, regionB])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const pts = [...(regionA ?? []), ...(regionB ?? [])]
    if (pts.length === 0) return
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
    for (const [lon, lat] of pts) {
      w = Math.min(w, lon); e = Math.max(e, lon)
      s = Math.min(s, lat); n = Math.max(n, lat)
    }
    // Web Mercator cannot show the poles; clamp so polar regions still fit
    s = Math.max(s, -80); n = Math.min(n, 82)
    const narrow = map.getContainer().clientWidth < 700
    if (e - w > 300) {
      // a band around the whole planet: show the world, centred on its latitude
      map.jumpTo({ center: [20, Math.max(-50, Math.min(55, (s + n) / 2))], zoom: narrow ? 1 : 1.6 })
      return
    }
    const pad = narrow ? 24 : 60
    map.fitBounds([[w, s], [e, n]], {
      padding: { top: pad, bottom: pad, left: pad, right: pad },
      maxZoom: 4.5,
      duration: prefersReducedMotion() ? 0 : 600,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, styleReady])

  // ---- rectangle drawing -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const canvas = map.getCanvas()
    canvas.style.cursor = drawing ? 'crosshair' : ''
    if (drawing) {
      map.dragPan.disable()
      map.boxZoom.disable()
      map.doubleClickZoom.disable()
    } else {
      map.dragPan.enable()
      map.boxZoom.enable()
      map.doubleClickZoom.enable()
    }

    const ensure = () => {
      if (!map.getSource('draw-preview')) {
        map.addSource('draw-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({ id: 'draw-preview-line', type: 'line', source: 'draw-preview',
          paint: { 'line-color': tokens(live.current.theme).leaf, 'line-width': 2.5, 'line-dasharray': [2, 2] } })
      }
    }
    const rectPolygon = (a: [number, number], b: [number, number]): Polygon =>
      [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]

    const down = (e: maplibregl.MapMouseEvent) => {
      if (!drawing) return
      drawState.current.start = [e.lngLat.lng, e.lngLat.lat]
      ensure()
    }
    const move = (e: maplibregl.MapMouseEvent) => {
      if (!drawing) return
      const anchor = drawState.current.start ?? drawState.current.anchor ?? null
      if (!anchor) return
      drawState.current.cur = [e.lngLat.lng, e.lngLat.lat]
      const src = map.getSource('draw-preview') as maplibregl.GeoJSONSource
      src?.setData({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [rectPolygon(anchor, drawState.current.cur).concat([anchor])] },
      })
    }
    const up = (e: maplibregl.MapMouseEvent) => {
      if (!drawing || !drawState.current.start) return
      const a = drawState.current.start
      const b: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      drawState.current.start = null
      // A plain click (no drag) must leave the two-click anchor alone; the
      // 'click' handler below completes the rectangle on the second click.
      // Clearing the anchor here made "click two opposite corners" impossible.
      if (!(Math.abs(a[0] - b[0]) > 0.3 && Math.abs(a[1] - b[1]) > 0.3)) return
      drawState.current.anchor = null
      const src = map.getSource('draw-preview') as maplibregl.GeoJSONSource
      src?.setData({ type: 'FeatureCollection', features: [] })
      onDrawn(rectPolygon(a, b))
    }
    // two-click mode: first click anchors, second click completes — works even
    // when drag events are unavailable (touchpads, embedded browsers)
    const click = (e: maplibregl.MapMouseEvent) => {
      if (!drawing) return
      if (!drawState.current.anchor && !drawState.current.start) {
        drawState.current.anchor = [e.lngLat.lng, e.lngLat.lat]
        ensure()
      } else if (drawState.current.anchor && !drawState.current.start) {
        const a = drawState.current.anchor
        const b: [number, number] = [e.lngLat.lng, e.lngLat.lat]
        drawState.current.anchor = null
        const src = map.getSource('draw-preview') as maplibregl.GeoJSONSource
        src?.setData({ type: 'FeatureCollection', features: [] })
        if (Math.abs(a[0] - b[0]) > 0.3 && Math.abs(a[1] - b[1]) > 0.3) {
          onDrawn(rectPolygon(a, b))
        }
      }
    }
    map.on('mousedown', down)
    map.on('mousemove', move)
    map.on('mouseup', up)
    map.on('click', click)
    return () => {
      map.off('mousedown', down)
      map.off('mousemove', move)
      map.off('mouseup', up)
      map.off('click', click)
    }
  }, [drawing, onDrawn])

  // ---- hover -> grid cell ------------------------------------------------
  function handleHover(e: maplibregl.MapMouseEvent) {
    const { grid: g, drawing: isDrawing, onHover: report } = live.current
    const { lng: lon, lat } = e.lngLat
    if (isDrawing) { report(null); return }
    const nLat = g.lats.length, nLon = g.lons.length
    if (!nLat || !nLon) return
    const lon0 = g.lons[0], lon1 = g.lons[nLon - 1]
    const lat0 = g.lats[0], lat1 = g.lats[nLat - 1]
    if (lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1) { report(null); return }
    const j = Math.round((lon - lon0) / ((lon1 - lon0) / (nLon - 1)))
    const i = Math.round((lat - lat0) / ((lat1 - lat0) / (nLat - 1)))
    const el = e.target.getContainer()
    report({ lon, lat, pixelIdx: i * nLon + j, x: e.point.x, y: e.point.y, w: el.clientWidth, h: el.clientHeight })
  }

  return (
    <div className="map">
      <div ref={containerRef} className="map-gl" />
    </div>
  )
}

/** Legend: stepped data scale (same nine steps the map uses), plain-word ends, units. */
export function MapLegend({ vmaxPerDecade, trendUnits, showSignificance, regionLevel }: {
  vmaxPerDecade: number
  trendUnits: string
  showSignificance: boolean
  /** true for variables that only have regional verdicts, no per-cell map */
  regionLevel?: boolean
}) {
  if (regionLevel) {
    return (
      <div className="legend" role="group" aria-label="Map legend">
        <div className="legend-head"><b>{trendUnits}</b></div>
        <ul className="legend-keys">
          <li><span className="swatch" style={{ background: 'var(--d-8)' }} /> Detected increase</li>
          <li><span className="swatch" style={{ background: 'var(--d-2)' }} /> Detected decrease</li>
          <li><span className="swatch hatch" style={{ backgroundColor: 'var(--paper-sunk)' }} /> No clear trend</li>
          <li><span className="swatch hatch" /> Too little data</li>
        </ul>
        <p className="legend-note">Regional results only: this record has no per-cell map. Colour shows direction, never good or bad.</p>
      </div>
    )
  }
  const v = vmaxPerDecade.toFixed(2)
  return (
    <div className="legend" role="group" aria-label="Map legend">
      <div className="legend-head"><b>{trendUnits}</b></div>
      <div className="legend-scale" aria-hidden="true">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => <span key={k} style={{ background: `var(--d-${k})` }} />)}
      </div>
      <div className="legend-ends">
        <span>&minus;{v}<br /><em>decrease</em></span>
        <span className="mid">0</span>
        <span>+{v}<br /><em>increase</em></span>
      </div>
      <details className="legend-more">
        <summary>What the shading means</summary>
        {showSignificance && (
          <ul className="legend-keys">
            <li><span className="swatch" style={{ background: 'var(--d-8)' }} /> Trend detected</li>
            <li><span className="swatch" style={{ background: 'color-mix(in oklab, var(--d-8) 40%, var(--paper))' }} /> Not detected (faded)</li>
            <li><span className="swatch naive" /> Naive test only; persistence removed it</li>
            <li><span className="swatch wash" /> Too little data</li>
          </ul>
        )}
        <p className="legend-note">Colour shows direction and size of change, never good or bad. Cells are FDR-corrected.</p>
      </details>
    </div>
  )
}
