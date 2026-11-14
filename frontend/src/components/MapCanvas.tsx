import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map as MLMap } from 'maplibre-gl'
import type { Grid, TrendPack } from '../engine/loader'
import type { Polygon } from '../engine/geography'
import type { RegionVerdict } from '../engine/missions'
import { verdictColor } from '../engine/missions'

export interface MapCanvasProps {
  grid: Grid
  domain: { lon_min: number; lon_max: number; lat_min: number; lat_max: number }
  trends: TrendPack | null
  showSignificance: boolean
  regionA: Polygon | null
  regionB: Polygon | null
  drawing: boolean
  onDrawn: (polygon: Polygon) => void
  onHover: (info: { lon: number; lat: number; pixelIdx: number } | null) => void
  trendUnits: string
  regionVerdicts?: RegionVerdict[] | null
}

const UPSCALE = 5

const FALLBACK_STYLE = {
  version: 8 as const,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    coast: { type: 'geojson' as const, data: './coastline.json' },
  },
  layers: [
    { id: 'bg', type: 'background' as const, paint: { 'background-color': '#0a1120' } },
    { id: 'coastline', type: 'line' as const, source: 'coast',
      paint: { 'line-color': '#26334f', 'line-width': 1.2 } },
  ],
}

/** Keep stacking order stable regardless of effect timing:
 * coastline < trend raster < region outlines. */
function enforceLayerOrder(map: MLMap) {
  for (const id of ['es-coast-line', 'region-verdicts-fill', 'region-verdicts-line', 'trend-layer', 'region-a-fill', 'region-a-line', 'region-b-fill', 'region-b-line']) {
    if (map.getLayer(id)) map.moveLayer(id)
  }
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

/** Symmetric diverging colour for a slope in [-vmax, vmax]. */
function slopeColor(slope: number, vmax: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, slope / (vmax || 1)))
  // cool blue -> dark neutral -> warm red
  if (t >= 0) {
    const u = Math.pow(t, 0.75)
    return [Math.round(20 + u * 225), Math.round(26 + u * 103), Math.round(46 + u * 46)]
  }
  const u = Math.pow(-t, 0.75)
  return [Math.round(20 + u * 52), Math.round(26 + u * 131), Math.round(46 + u * 209)]
}

export default function MapCanvas(props: MapCanvasProps) {
  const { grid, domain, trends, showSignificance, regionA, regionB, drawing, onDrawn, onHover, regionVerdicts } = props
  const mapRef = useRef<MLMap | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trendUrlRef = useRef<string | null>(null)
  const [styleReady, setStyleReady] = useState(false)
  const drawState = useRef<{ start: [number, number] | null; cur: [number, number] | null; anchor: [number, number] | null }>({ start: null, cur: null, anchor: null })
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // ---- init map once -----------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [20, 20],
      zoom: 1.6,
      minZoom: 1,
      maxZoom: 8,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    ;(window as unknown as { __esMap?: MLMap }).__esMap = map // diagnostics handle
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', (e) => {
      // if the remote style fails entirely (offline demo), fall back to the
      // local coastline style so the map still renders
      const msg = String((e as unknown as { error?: Error }).error?.message ?? '')
      const status = (e as unknown as { error?: { status?: number } }).error?.status
      if (status !== undefined || /style|Failed|fetch/i.test(msg)) {
        const cur = map.getStyle()
        if (cur && Object.keys(cur.sources ?? {}).length === 0) {
          map.setStyle(FALLBACK_STYLE as never)
        }
      }
    })
    // Ready as soon as a style with sources exists — never depend on tile
    // servers answering, or the overlays would not appear on a weak network.
    map.on('styledata', () => {
      const srcs = Object.keys(map.getStyle()?.sources ?? {})
      if (srcs.length > 0) setStyleReady(true)
    })
    const onMove = (e: maplibregl.MapMouseEvent) => handleHover(e.lngLat.lng, e.lngLat.lat)
    map.on('mousemove', onMove)
    map.on('mouseout', () => onHover(null))
    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- region-verdict layer for variables without a per-pixel map --------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady || !regionVerdicts) return
    if (!map.getSource('region-verdicts')) {
      map.addSource('region-verdicts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'region-verdicts-fill', type: 'fill', source: 'region-verdicts',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 },
      })
      map.addLayer({
        id: 'region-verdicts-line', type: 'line', source: 'region-verdicts',
        paint: { 'line-color': '#e7edf7', 'line-width': 1.2, 'line-opacity': 0.7 },
      })
    }
    const src = map.getSource('region-verdicts') as maplibregl.GeoJSONSource
    src.setData({
      type: 'FeatureCollection',
      features: regionVerdicts.map((v) => ({
        type: 'Feature' as const,
        properties: { color: verdictColor(v.label), name: v.name },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[...v.polygon, v.polygon[0]]],
        },
      })),
    })
    enforceLayerOrder(map)
  }, [regionVerdicts, styleReady])

  // ---- guaranteed coastline context + trend raster ------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady || !trends || !grid.lats.length) return

    // local coastline so geography stays readable even if tiles never load
    if (!map.getSource('es-coast')) {
      map.addSource('es-coast', { type: 'geojson', data: './coastline.json' })
      map.addLayer({
        id: 'es-coast-line', type: 'line', source: 'es-coast',
        paint: { 'line-color': '#3d4d6e', 'line-width': 0.8, 'line-opacity': 0.85 },
      })
    }
    const nLat = grid.lats.length, nLon = grid.lons.length
    const slopes = trends.slope
    const vmax = Math.max(slopeVmax(slopes), 1e-9)

    const img = document.createElement('canvas')
    img.width = nLon; img.height = nLat
    const ctx = img.getContext('2d')!
    const idata = ctx.createImageData(nLon, nLat)
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) {
        const p = i * nLon + j
        const code = trends.label[p] & 0x7f
        const o = ((nLat - 1 - i) * nLon + j) * 4  // flip: canvas y down
        if (code === 3 || !Number.isFinite(slopes[p])) {
          idata.data[o] = 40; idata.data[o + 1] = 44; idata.data[o + 2] = 52; idata.data[o + 3] = 120
          continue
        }
        const [r, g, b] = slopeColor(slopes[p], vmax)
        const significant = code === 0 || code === 1
        const naiveOnly = (trends.label[p] & 0x40) !== 0 && !significant
        // amber-tint cells the naive test called significant but persistence
        // adjustment removed: blend 45% toward amber
        const rr = naiveOnly ? Math.round(r * 0.55 + 255 * 0.45) : r
        const gg = naiveOnly ? Math.round(g * 0.55 + 193 * 0.45) : g
        const bb = naiveOnly ? Math.round(b * 0.55 + 94 * 0.45) : b
        idata.data[o] = rr; idata.data[o + 1] = gg; idata.data[o + 2] = bb
        idata.data[o + 3] = showSignificance
          ? (significant ? 235 : naiveOnly ? 205 : 55)
          : 205
      }
    }
    ctx.putImageData(idata, 0, 0)

    // upscale ×6 without smoothing (honest grid cells)
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas')
    const big = canvasRef.current
    big.width = nLon * UPSCALE; big.height = nLat * UPSCALE
    const bctx = big.getContext('2d')!
    bctx.imageSmoothingEnabled = false
    bctx.drawImage(img, 0, 0, big.width, big.height)
    const url = big.toDataURL()

    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [domain.lon_min, domain.lat_max],
      [domain.lon_max, domain.lat_max],
      [domain.lon_max, domain.lat_min],
      [domain.lon_min, domain.lat_min],
    ]
    const src = map.getSource('trend') as maplibregl.ImageSource | undefined
    if (src) {
      src.updateImage({ url, coordinates: coords })
    } else {
      map.addSource('trend', { type: 'image', url, coordinates: coords })
      map.addLayer({
        id: 'trend-layer', type: 'raster', source: 'trend',
        paint: { 'raster-opacity': 0.88, 'raster-fade-duration': 0 },
      })
    }
    enforceLayerOrder(map)
    trendUrlRef.current = url
  }, [trends, styleReady, grid, domain, showSignificance])

  // ---- region layers -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const ensure = (id: string, color: string) => {
      if (!map.getSource(id)) {
        map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: `${id}-fill`, type: 'fill', source: id,
          paint: { 'fill-color': color, 'fill-opacity': 0.12 },
        })
        map.addLayer({
          id: `${id}-line`, type: 'line', source: id,
          paint: { 'line-color': color, 'line-width': 2, 'line-dasharray': [3, 1.5] },
        })
      }
    }
    ensure('region-a', '#4f9cf9')
    ensure('region-b', '#ffb547')
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
          paint: { 'line-color': '#35c48d', 'line-width': 2, 'line-dasharray': [2, 2] } })
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
      drawState.current.anchor = null
      const src = map.getSource('draw-preview') as maplibregl.GeoJSONSource
      src?.setData({ type: 'FeatureCollection', features: [] })
      if (Math.abs(a[0] - b[0]) > 0.3 && Math.abs(a[1] - b[1]) > 0.3) {
        onDrawn(rectPolygon(a, b))
      }
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
  function handleHover(lon: number, lat: number) {
    if (drawing) { onHover(null); return }
    const nLat = grid.lats.length, nLon = grid.lons.length
    if (!nLat || !nLon) return
    const lon0 = grid.lons[0], lon1 = grid.lons[nLon - 1]
    const lat0 = grid.lats[0], lat1 = grid.lats[nLat - 1]
    if (lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1) { onHover(null); return }
    const j = Math.round((lon - lon0) / ((lon1 - lon0) / (nLon - 1)))
    const i = Math.round((lat - lat0) / ((lat1 - lat0) / (nLat - 1)))
    onHover({ lon, lat, pixelIdx: i * nLon + j })
  }

  return (
    <div className="map">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
}

export function legendGradient(vmaxPerDecade: number, trendUnits: string) {
  const stops: { color: string; label: string }[] = []
  for (let k = 5; k >= 1; k--) {
    const [r, g, b] = slopeColor((k / 5) * vmaxPerDecade, vmaxPerDecade)
    stops.push({ color: `rgb(${r},${g},${b})`, label: k === 5 ? `+${vmaxPerDecade.toFixed(2)}` : '' })
  }
  for (let k = 1; k <= 5; k++) {
    const [r, g, b] = slopeColor(-(k / 5) * vmaxPerDecade, vmaxPerDecade)
    stops.push({ color: `rgb(${r},${g},${b})`, label: k === 5 ? `−${vmaxPerDecade.toFixed(2)}` : '' })
  }
  return (
    <div className="maplegend">
      <b>{trendUnits}</b>
      <div className="bar" style={{ background: `linear-gradient(90deg, ${stops.map((s) => s.color).join(',')})` }} />
      <div className="lrow"><span className="sw" style={{ background: 'rgba(120,60,40,0.9)' }} /> significant increase</div>
      <div className="lrow"><span className="sw" style={{ background: 'rgb(214,148,88)' }} /> naive-only (persistence removed it)</div>
      <div className="lrow"><span className="sw" style={{ background: 'rgba(120,60,40,0.25)' }} /> trend, not significant</div>
      <div className="lrow"><span className="sw" style={{ background: 'rgba(40,44,52,0.6)' }} /> insufficient data</div>
      <div className="lrow muted" style={{ marginTop: 6 }}>Colour = direction &amp; size of change,<br />not “good” or “bad”. FDR-corrected.</div>
    </div>
  )
}
