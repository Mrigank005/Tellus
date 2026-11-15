import { useEffect, useMemo, useRef, useState } from 'react'
import { loadCatalog, loadGrid, loadTrendPack, type Catalog, type Grid, type TrendPack } from '../../engine/loader'
import { useStore } from '../../state/store'
import { useTheme } from '../../state/theme'
import { tokens } from '../../styles/tokens'
import { rampIndex, rampLut, rgba, sizeCanvas } from './HeroRings'

/** Plain words for the two ends of the colour scale, per variable. */
export const SCALE_WORDS: Record<string, [string, string]> = {
  T2M: ['Cooling', 'Warming'],
  T2M_MAX: ['Cooler days', 'Hotter days'],
  T2M_MIN: ['Cooler nights', 'Warmer nights'],
  PRECTOTCORR: ['Drier', 'Wetter'],
  RH2M: ['Less humid', 'More humid'],
  WS10M: ['Calmer', 'Windier'],
  GWETTOP: ['Drier soil', 'Wetter soil'],
  EVLAND: ['Less evaporation', 'More evaporation'],
}

const CELL_FADE = 105 // alpha (0-255) of cells that are not a detected trend

/** 98th percentile of |slope| so one extreme cell cannot wash out the map (same rule as the field desk). */
function robustMax(pack: TrendPack): number {
  const vals: number[] = []
  for (let i = 0; i < pack.slope.length; i++) {
    const v = Math.abs(pack.slope[i])
    if (Number.isFinite(v) && (pack.label[i] & 0x3f) !== 3) vals.push(v)
  }
  if (!vals.length) return 1e-9
  vals.sort((a, b) => a - b)
  return Math.max(vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))], 1e-9)
}

export function fmtValue(v: number): string {
  const a = Math.abs(v)
  const s = a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a >= 0.1 ? a.toFixed(2) : a.toFixed(3)
  return (v < 0 ? '−' : '+') + s
}

let coastPromise: Promise<number[][][]> | null = null
/** Land outlines from Natural Earth 110m, as arrays of [lon, lat] rings. */
function loadCoast(): Promise<number[][][]> {
  if (!coastPromise) {
    coastPromise = fetch('./coastline.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('coastline'))))
      .then((gj: { features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[] }) => {
        const rings: number[][][] = []
        for (const f of gj.features) {
          const g = f.geometry
          if (g.type === 'Polygon') (g.coordinates as number[][][]).forEach((r) => rings.push(r))
          else if (g.type === 'MultiPolygon') (g.coordinates as number[][][][]).forEach((p) => p.forEach((r) => rings.push(r)))
        }
        return rings
      })
      .catch(() => { coastPromise = null; return [] })
  }
  return coastPromise
}

interface Painted {
  pack: TrendPack
  variableId: string
  season: string
  windowId: string
  vmax: number // per year
}

interface Layers { pack: TrendPack; theme: string; img: HTMLCanvasElement; mask: HTMLCanvasElement }

interface Hover { left: number; top: number; flip: boolean; dotX: number; dotY: number; value: string | null; status: string; place: string }

export default function AskTapestry() {
  const theme = useTheme((s) => s.theme)
  const variableId = useStore((s) => s.variableId)
  const season = useStore((s) => s.season)
  const windowId = useStore((s) => s.windowId)
  const regionId = useStore((s) => s.regionId)
  const customPolygon = useStore((s) => s.customPolygon)

  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [grid, setGrid] = useState<Grid | null>(null)
  const [coast, setCoast] = useState<number[][][] | null>(null)
  const [painted, setPainted] = useState<Painted | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)
  const [tick, setTick] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const layers = useRef<Layers | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([loadCatalog(), loadGrid(), loadCoast()])
      .then(([c, g, k]) => { if (live) { setCatalog(c); setGrid(g); setCoast(k) } })
      .catch(() => { if (live) { setFailed(true); setLoading(false) } })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!catalog) return
    let live = true
    setLoading(true); setFailed(false)
    loadTrendPack(variableId, season, windowId, catalog.n_cells)
      .then((pack) => { if (live) { setPainted({ pack, variableId, season, windowId, vmax: robustMax(pack) }); setLoading(false) } })
      .catch(() => { if (live) { setFailed(true); setLoading(false) } })
    return () => { live = false }
  }, [catalog, variableId, season, windowId])

  const polygon = useMemo(() => {
    if (regionId === 'custom') return customPolygon
    return catalog?.regions.find((r) => r.id === regionId)?.polygon ?? null
  }, [catalog, regionId, customPolygon])

  // geometry of the grid inside the 360 x 180 degree canvas
  const geo = useMemo(() => {
    if (!grid) return null
    const nLat = grid.lats.length, nLon = grid.lons.length
    const dlat = (grid.lats[nLat - 1] - grid.lats[0]) / (nLat - 1)
    const dlon = (grid.lons[nLon - 1] - grid.lons[0]) / (nLon - 1)
    return { nLat, nLon, dlat, dlon, lat0: grid.lats[0], lon0: grid.lons[0] }
  }, [grid])

  useEffect(() => {
    const c = canvasRef.current
    if (!c || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick((v) => v + 1)) })
    ro.observe(c)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [])

  // ---- paint ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !geo) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const t = tokens(theme)
    const { w, h, d } = sizeCanvas(canvas)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = t.paperRaised; ctx.fillRect(0, 0, w, h)

    if (painted) {
      const { nLat, nLon, dlat, dlon, lat0, lon0 } = geo
      const { pack, vmax } = painted
      // cell images at grid resolution, cached per pack and theme
      let L = layers.current
      if (!L || L.pack !== pack || L.theme !== theme) {
        const img = document.createElement('canvas'); img.width = nLon; img.height = nLat
        const mask = document.createElement('canvas'); mask.width = nLon; mask.height = nLat
        const id = img.getContext('2d')!.createImageData(nLon, nLat)
        const md = mask.getContext('2d')!.createImageData(nLon, nLat)
        const lut = rampLut(theme)
        for (let i = 0; i < nLat; i++) {
          for (let j = 0; j < nLon; j++) {
            const p = i * nLon + j, s = pack.slope[p], code = pack.label[p] & 0x3f
            if (!Number.isFinite(s) || code === 3) continue // no data: leave as paper
            const o = ((nLat - 1 - i) * nLon + j) * 4, k = rampIndex(s / vmax)
            const detected = code === 0 || code === 1
            id.data[o] = lut[k]; id.data[o + 1] = lut[k + 1]; id.data[o + 2] = lut[k + 2]
            id.data[o + 3] = detected ? 255 : CELL_FADE
            if (!detected) md.data[o + 3] = 255
          }
        }
        img.getContext('2d')!.putImageData(id, 0, 0)
        mask.getContext('2d')!.putImageData(md, 0, 0)
        L = layers.current = { pack, theme, img, mask }
      }
      const x0 = (lon0 - dlon / 2 + 180) / 360 * w, dw = nLon * dlon / 360 * w
      const y0 = (90 - (lat0 + (nLat - 1) * dlat + dlat / 2)) / 180 * h, dh = nLat * dlat / 180 * h
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(L.img, x0, y0, dw, dh)
      // 45 degree hatch over the cells that are not a detected trend
      const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h
      const tc = tmp.getContext('2d')!
      tc.imageSmoothingEnabled = false
      tc.drawImage(L.mask, x0, y0, dw, dh)
      tc.globalCompositeOperation = 'source-in'
      const s = Math.max(4, Math.round(5 * d))
      const pat = document.createElement('canvas'); pat.width = s; pat.height = s
      const pc = pat.getContext('2d')!
      pc.strokeStyle = rgba(t.ink, theme === 'dusk' ? 0.4 : 0.45); pc.lineWidth = Math.max(1, d * 0.9)
      pc.beginPath(); pc.moveTo(-1, s + 1); pc.lineTo(s + 1, -1); pc.moveTo(-1, 1); pc.lineTo(1, -1); pc.moveTo(s - 1, s + 1); pc.lineTo(s + 1, s - 1); pc.stroke()
      tc.fillStyle = tc.createPattern(pat, 'repeat')!; tc.fillRect(0, 0, w, h)
      ctx.drawImage(tmp, 0, 0)
    }

    // coastline in ink at low opacity
    if (coast) {
      ctx.strokeStyle = rgba(t.ink, theme === 'dusk' ? 0.5 : 0.42); ctx.lineWidth = Math.max(0.8, d * 0.9); ctx.lineJoin = 'round'
      for (const ring of coast) {
        ctx.beginPath()
        ring.forEach(([lo, la], k) => { const x = (lo + 180) / 360 * w, y = (90 - la) / 180 * h; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
        ctx.stroke()
      }
    }

    // the selected region: soft copper fill, paper casing, copper line
    const outline = (path: () => void) => {
      path()
      ctx.fillStyle = rgba(t.copper, 0.14); ctx.fill()
      ctx.lineWidth = 4.5 * d; ctx.strokeStyle = rgba(t.paperRaised, 0.85); ctx.stroke()
      ctx.lineWidth = 2.2 * d; ctx.strokeStyle = t.copper; ctx.stroke()
    }
    if (regionId === 'whole-earth') {
      outline(() => { ctx.beginPath(); ctx.rect(2 * d, 2 * d, w - 4 * d, h - 4 * d) })
    } else if (polygon && polygon.length > 2) {
      outline(() => {
        ctx.beginPath()
        polygon.forEach(([lo, la], k) => { const x = (lo + 180) / 360 * w, y = (90 - la) / 180 * h; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
        ctx.closePath()
      })
    }
  }, [geo, painted, coast, theme, polygon, regionId, tick])

  // ---- hover ---------------------------------------------------------------
  const onMove = (e: React.PointerEvent) => {
    const c = canvasRef.current, wrap = wrapRef.current
    if (!c || !wrap || !geo || !painted) return
    const r = c.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height
    const lon = fx * 360 - 180, lat = 90 - fy * 180
    const j = Math.round((lon - geo.lon0) / geo.dlon), i = Math.round((lat - geo.lat0) / geo.dlat)
    if (i < 0 || j < 0 || i >= geo.nLat || j >= geo.nLon) { setHover(null); return }
    const p = i * geo.nLon + j, s = painted.pack.slope[p], code = painted.pack.label[p] & 0x3f
    if (!Number.isFinite(s)) { setHover(null); return }
    const cLat = geo.lat0 + i * geo.dlat, cLon = geo.lon0 + j * geo.dlon
    const place = `${Math.abs(cLat).toFixed(1)}°${cLat >= 0 ? 'N' : 'S'}, ${Math.abs(cLon).toFixed(1)}°${cLon >= 0 ? 'E' : 'W'}`
    const units = catalog?.variables.find((v) => v.id === painted.variableId)?.trend_units ?? 'per decade'
    const x = e.clientX - r.left
    setHover({
      left: Math.max(96, Math.min(r.width - 96, x)), top: e.clientY - r.top, flip: e.clientY - r.top < 84,
      dotX: ((cLon + 180) / 360) * 100, dotY: ((90 - cLat) / 180) * 100,
      value: code === 3 ? null : `${fmtValue(s * 10)} ${units}`,
      status: code === 0 || code === 1 ? 'Detected' : code === 3 ? 'Too little data for a trend here' : 'Not a clear trend',
      place,
    })
  }

  const variable = catalog?.variables.find((v) => v.id === (painted?.variableId ?? variableId))
  const win = catalog?.windows.find((w) => w.id === (painted?.windowId ?? windowId))
  const seasonLabel = painted?.season === 'annual' ? 'whole year' : catalog?.seasons[painted?.season ?? season]?.label.toLowerCase()
  const words = SCALE_WORDS[painted?.variableId ?? variableId] ?? ['Decrease', 'Increase']
  const vmaxDecade = painted ? painted.vmax * 10 : null
  const units = variable?.trend_units ?? 'per decade'

  return (
    <div className="tapestry-wrap" ref={wrapRef}>
      <div className="tap-stage">
        <canvas
          ref={canvasRef}
          className={`tapestry${loading ? ' is-loading' : ''}`}
          role="img"
          aria-label={variable
            ? `World map of how fast ${variable.short_name.toLowerCase()} changed per decade, ${win ? `${win.start} to ${win.end}` : ''}. Each pane is a patch of Earth; faded hatched panes are not a clear trend.`
            : 'World map of change per decade'}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        />
        {hover && <span className="tap-dot" style={{ left: `${hover.dotX}%`, top: `${hover.dotY}%` }} aria-hidden="true" />}
        {hover && (
          <div className={`tap-tip tip${hover.flip ? ' below' : ''}`} style={{ left: hover.left, top: hover.top }} role="status">
            {hover.value && <b>{hover.value}</b>}
            <span>{hover.status}</span>
            <span className="num">{hover.place}</span>
          </div>
        )}
        {(loading || failed) && (
          <div className="tap-status" role="status">
            {failed
              ? 'That map could not be loaded. Try another choice.'
              : <><span className="spinner" aria-hidden="true" /> Reading the NASA record…</>}
          </div>
        )}
      </div>
      <div className="tap-legend">
        <span className="tap-caption">
          {variable && win
            ? <>Each pane is a patch of Earth about 50 km across, coloured by how fast {variable.short_name.toLowerCase()} changed per decade, {win.start}–{win.end}, {seasonLabel}.</>
            : 'Each pane is a patch of Earth about 50 km across.'}
        </span>
        <span className="tap-keys">
          <span className="tap-scale">
            <i className="scale-bar" aria-hidden="true" />
            <span className="tap-end"><span className="tap-word">{words[0]}</span> <span className="num">{vmaxDecade != null ? fmtValue(-vmaxDecade) : ''}</span></span>
            <span className="tap-end r"><span className="num">{vmaxDecade != null ? fmtValue(vmaxDecade) : ''}</span> <span className="tap-word">{words[1]}</span></span>
            <span className="tap-unit">{units}</span>
          </span>
          <span className="tap-hatch"><i className="hatch" aria-hidden="true" /> Not a clear trend</span>
        </span>
      </div>
    </div>
  )
}
