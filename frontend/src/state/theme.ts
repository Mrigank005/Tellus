import { create } from 'zustand'

/**
 * Day (light paper) or Dusk (dark).
 *
 * Tellus follows the device: it starts in the device's light/dark setting and switches live
 * when the device switches (for example at sunset, or when the OS setting changes).
 * The header button is a manual override for this viewer. The override is dropped as soon as
 * the device changes its setting, or when the viewer toggles back to what the device uses,
 * so the site and the device come back into sync. Open tabs share the choice.
 */
export type Theme = 'day' | 'dusk'

/** Stored as {"theme": "day"|"dusk", "against": "day"|"dusk"}: the choice, and the device setting it was made against. */
export const OVERRIDE_KEY = 'tellus-theme-override'
const LEGACY_KEY = 'tellus-theme'

function mql(): MediaQueryList | null {
  try { return window.matchMedia('(prefers-color-scheme: dark)') } catch { return null }
}

function deviceTheme(): Theme {
  return mql()?.matches ? 'dusk' : 'day'
}

const isTheme = (x: unknown): x is Theme => x === 'day' || x === 'dusk'

/**
 * The viewer's manual choice, honoured only while the device still reports the setting it was
 * made against. If the device switched while Tellus was closed, the choice is dropped.
 */
function readOverride(): Theme | null {
  try {
    localStorage.removeItem(LEGACY_KEY) // older builds stored every toggle here; ignore it
    const raw = localStorage.getItem(OVERRIDE_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as { theme?: unknown; against?: unknown }
    if (isTheme(o.theme) && isTheme(o.against) && o.against === deviceTheme() && o.theme !== o.against) return o.theme
    localStorage.removeItem(OVERRIDE_KEY)
  } catch { /* storage blocked or bad JSON */ }
  return null
}

function writeOverride(t: Theme | null) {
  try {
    if (t) localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ theme: t, against: deviceTheme() }))
    else localStorage.removeItem(OVERRIDE_KEY)
  } catch { /* storage blocked: the choice lasts for this page only */ }
}

function apply(theme: Theme) {
  if (theme === 'dusk') document.documentElement.dataset.theme = 'dusk'
  else delete document.documentElement.dataset.theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'dusk' ? '#0E1D17' : '#F6F1E3')
}

interface ThemeState {
  theme: Theme
  /** true while the viewer's manual choice differs from the device */
  overridden: boolean
  toggle: () => void
}

const startOverride = readOverride()
const start: Theme = startOverride ?? deviceTheme()
apply(start)

export const useTheme = create<ThemeState>((set, get) => ({
  theme: start,
  overridden: startOverride !== null,
  toggle: () => {
    const next: Theme = get().theme === 'dusk' ? 'day' : 'dusk'
    // toggling back to the device's own setting means "follow the device again"
    const override = next === deviceTheme() ? null : next
    writeOverride(override)
    apply(next)
    set({ theme: next, overridden: override !== null })
  },
}))

// the device changed its setting: follow it, and drop any manual override
const media = mql()
const onDevice = () => {
  writeOverride(null)
  const t = deviceTheme()
  apply(t)
  useTheme.setState({ theme: t, overridden: false })
}
if (media) {
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onDevice)
  else (media as MediaQueryList & { addListener?: (cb: () => void) => void }).addListener?.(onDevice)
}

// another open tab changed the choice: match it
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== OVERRIDE_KEY && e.key !== null) return
    const o = readOverride()
    const t = o ?? deviceTheme()
    apply(t)
    useTheme.setState({ theme: t, overridden: o !== null })
  })
} catch { /* no window events */ }
