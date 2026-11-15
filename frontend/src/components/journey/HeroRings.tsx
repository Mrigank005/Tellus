import { useCallback, useEffect, useRef, useState } from 'react'
import { loadPresets } from '../../engine/loader'
import { useTheme, type Theme } from '../../state/theme'
import { dataScale, prefersReducedMotion, tokens } from '../../styles/tokens'

/* ---------- shared canvas helpers (also used by AskTapestry) ---------- */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

const RAMP_N = 512
const rampCache = new Map<Theme, Uint8Array>()

/** A smooth 513-step lookup table over the 9-step diverging data scale, tide (-1) to ember (+1). */
export function rampLut(theme: Theme): Uint8Array {
  const hit = rampCache.get(theme)
  if (hit) return hit
  const stops = dataScale(theme).map(hexToRgb)
  const lut = new Uint8Array((RAMP_N + 1) * 3)
  for (let k = 0; k <= RAMP_N; k++) {
    const x = (k / RAMP_N) * (stops.length - 1)
    const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i
    for (let c = 0; c < 3; c++) lut[k * 3 + c] = Math.round(stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f)
  }
  rampCache.set(theme, lut)
  return lut
}

/** Index into a ramp LUT for a value in [-1, 1] (clamped). */
export function rampIndex(t: number): number {
  return Math.round((Math.max(-1, Math.min(1, t)) + 1) / 2 * RAMP_N) * 3
}

export function rampCss(lut: Uint8Array, t: number): string {
  const k = rampIndex(t)
  return `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`
}

export function sizeCanvas(c: HTMLCanvasElement) {
  const r = c.getBoundingClientRect()
  const d = Math.min(2, window.devicePixelRatio || 1)
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d))
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  return { w, h, d }
}

/* ---------- the ring disc ---------- */

const MAX_ANOMALY = 0.8 // degC at either end of the colour scale; the data run from -0.32 to +0.78
const BASE_FROM = 1981, BASE_TO = 2010

// One shared wobble (neighbouring rings look alike, as in real wood) plus a slow per-ring drift.
const PHASES = Array.from({ length: 6 }, (_, k) => (Math.sin(k * 12.9898) * 43758.5453) % (Math.PI * 2))
const wob = (th: number, i: number) =>
  1 + 0.014 * Math.sin(2 * th + PHASES[0]) + 0.009 * Math.sin(5 * th + PHASES[1] + i * 0.05) + 0.004 * Math.sin(11 * th + PHASES[2] - i * 0.09)

function ringPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, i: number) {
  ctx.beginPath()
  for (let s = 0; s <= 160; s++) {
    const th = (s / 160) * Math.PI * 2, r = R * wob(th, i)
    if (s) ctx.lineTo(cx + r * Math.cos(th), cy + r * Math.sin(th))
    else ctx.moveTo(cx + r * Math.cos(th), cy + r * Math.sin(th))
  }
  ctx.closePath()
}

const fmtSigned = (v: number, d = 2) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d)

function describe(anom: number): string {
  const r = Math.round(anom * 100) / 100
  if (r === 0) return `About the same as the ${BASE_FROM}–${BASE_TO} average`
  return `${fmtSigned(r)} °C ${r > 0 ? 'warmer' : 'cooler'} than the ${BASE_FROM}–${BASE_TO} average`
}

interface RingData { years: number[]; anom: number[] }

export default function HeroRings() {
  const theme = useTheme((s) => s.theme)
  const [data, setData] = useState<RingData | null>(null)
  const [failed, setFailed] = useState(false)
  const [sel, setSel] = useState<number | null>(null)
  const [tick, setTick] = useState(0) // bumps on resize
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progress = useRef(0)
  const geom = useRef<{ cx: number; cy: number; pith: number; step: number; d: number } | null>(null)

  // Real whole-Earth annual T2M from the presets, as anomalies against the 1981-2010 mean.
  useEffect(() => {
    let live = true
    loadPresets()
      .then((p) => {
        const e = p.T2M?.annual?.['whole-earth']
        if (!e) throw new Error('missing whole-earth series')
        const base = e.years.map((y, i) => ({ y, v: e.values[i] })).filter((o) => o.y >= BASE_FROM && o.y <= BASE_TO && o.v != null)
        const mean = base.reduce((a, o) => a + (o.v as number), 0) / base.length
        const years: number[] = [], anom: number[] = []
        e.years.forEach((y, i) => { const v = e.values[i]; if (v != null) { years.push(y); anom.push(v - mean) } })
        if (live) setData({ years, anom })
      })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  const draw = useCallback((p: number) => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const t = tokens(theme), lut = rampLut(theme)
    const { w, h, d } = sizeCanvas(canvas)
    const cx = w / 2, cy = h / 2, Rmax = Math.min(w, h) * 0.44, pith = Rmax * 0.05
    const n = data.anom.length, step = (Rmax - pith) / n
    geom.current = { cx, cy, pith, step, d }
    ctx.clearRect(0, 0, w, h)
    const shown = Math.max(0, Math.min(n, Math.floor(p * n + 0.0001)))
    if (shown === n) {
      ringPath(ctx, cx, cy, Rmax + step * 1.6, n + 1)
      ctx.fillStyle = t.copper; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1
    }
    const line = theme === 'dusk' ? rgba(t.paper, 0.5) : rgba(t.ink, 0.3)
    for (let i = shown - 1; i >= 0; i--) {
      ringPath(ctx, cx, cy, pith + step * (i + 1), i)
      ctx.fillStyle = rampCss(lut, data.anom[i] / MAX_ANOMALY); ctx.fill()
      ctx.lineWidth = Math.max(0.6, d * 0.7); ctx.strokeStyle = line; ctx.stroke()
    }
    ctx.beginPath(); ctx.arc(cx, cy, pith, 0, Math.PI * 2); ctx.fillStyle = t.copper; ctx.fill()
    if (sel != null && sel < shown) {
      ctx.strokeStyle = t.sun
      ringPath(ctx, cx, cy, pith + step * (sel + 1), sel); ctx.lineWidth = 2.5 * d; ctx.stroke()
      ringPath(ctx, cx, cy, pith + step * sel, sel); ctx.lineWidth = 1.2 * d; ctx.stroke()
    }
  }, [data, theme, sel])

  // The one authored moment of the page: rings grow from the heart to the bark.
  useEffect(() => {
    if (!data) return
    if (prefersReducedMotion()) { progress.current = 1; draw(1); return }
    let raf = 0
    const t0 = performance.now(), dur = 2200
    const frame = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      progress.current = 1 - Math.pow(1 - p, 3)
      draw(progress.current)
      if (p < 1) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // Only restart the growth when the data arrive; redraws for theme/selection are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => { draw(progress.current) }, [draw, tick])

  useEffect(() => {
    const c = canvasRef.current
    if (!c || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick((v) => v + 1)) })
    ro.observe(c)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [])

  const ringAt = (clientX: number, clientY: number): number | null => {
    const c = canvasRef.current, g = geom.current
    if (!c || !g || !data) return null
    const r = c.getBoundingClientRect()
    const x = (clientX - r.left) * g.d - g.cx, y = (clientY - r.top) * g.d - g.cy
    const th = Math.atan2(y, x), dist = Math.hypot(x, y)
    const i = Math.floor((dist / wob(th < 0 ? th + Math.PI * 2 : th, 20) - g.pith) / g.step)
    return i >= 0 && i < data.anom.length ? i : null
  }

  const last = data ? data.anom.length - 1 : 0
  const idx = sel ?? last
  const year = data ? data.years[idx] : null
  const text = data ? describe(data.anom[idx]) : failed ? 'The temperature record could not be loaded.' : 'Reading the record…'

  const onKey = (e: React.KeyboardEvent) => {
    if (!data) return
    const cur = sel ?? last
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(last, sel == null ? last : cur + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, cur - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else if (e.key === 'Escape') { setSel(null); return }
    if (next == null) return
    e.preventDefault()
    setSel(next)
  }

  return (
    <div className="arch">
      <div className="arch-glass" />
      <svg className="frame" viewBox="0 0 580 720" preserveAspectRatio="none" aria-hidden="true">
        <path d="M10 710 V290 A280 280 0 0 1 570 290 V710 Z" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".7" />
        <path d="M22 710 V292 A268 268 0 0 1 558 292 V710" fill="none" stroke="currentColor" strokeWidth=".8" opacity=".45" />
        <g fill="none" stroke="currentColor" strokeWidth="1" opacity=".55">
          <path d="M22 300 C 50 280, 60 250, 92 236 C 70 262, 58 282, 22 330" />
          <path d="M558 300 C 530 280, 520 250, 488 236 C 510 262, 522 282, 558 330" />
          <path d="M290 22 C 280 40, 280 52, 290 66 C 300 52, 300 40, 290 22 Z" />
        </g>
      </svg>
      <canvas
        ref={canvasRef}
        className="rings"
        tabIndex={0}
        role="slider"
        aria-label="Tree-ring disc of whole-Earth air temperature, one ring per year. Use the arrow keys to move between years."
        aria-orientation="horizontal"
        aria-valuemin={data?.years[0] ?? 1981}
        aria-valuemax={data?.years[last] ?? 2025}
        aria-valuenow={year ?? undefined}
        aria-valuetext={year != null ? `${year}: ${text}` : text}
        onPointerMove={(e) => { const i = ringAt(e.clientX, e.clientY); setSel((cur) => (i === cur ? cur : i)) }}
        onPointerDown={(e) => { if (e.pointerType !== 'mouse') setSel(ringAt(e.clientX, e.clientY)) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setSel(null) }}
        onKeyDown={onKey}
        onBlur={() => setSel(null)}
      />
      <div className="readout">
        <b>{year ?? ' '}</b>
        <span>{text}</span>
      </div>
    </div>
  )
}
