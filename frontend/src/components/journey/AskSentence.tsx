import { useEffect, useMemo, useRef, useState } from 'react'
import { loadCatalog, loadPresets, type Catalog, type Presets } from '../../engine/loader'
import { useStore } from '../../state/store'
import { place, spanPhrase, seasonPhrase as seasonPhraseOf } from '../../state/places'
import { Icon, type IconName } from '../Icon'

type Kind = 'region' | 'variable' | 'window' | 'season'

interface Opt { id: string; label: string; sub: string; icon: IconName; disabled?: boolean; note?: string }

/** Plain-language wording per variable: the word that completes "getting ...", a one-line description and an icon. */
const VARIABLE_COPY: Record<string, { change: string; sub: string; icon: IconName }> = {
  T2M: { change: 'warmer', sub: 'Average air temperature, 2 m above the ground', icon: 'thermo' },
  T2M_MAX: { change: 'hotter by day', sub: 'The hottest air temperature of each month', icon: 'sun' },
  T2M_MIN: { change: 'warmer at night', sub: 'The coldest air temperature of each month', icon: 'moon' },
  PRECTOTCORR: { change: 'wetter', sub: 'Rain and snow reaching the ground', icon: 'drop' },
  RH2M: { change: 'more humid', sub: 'How full of water vapour the air is', icon: 'tilde' },
  WS10M: { change: 'windier', sub: 'Wind speed, 10 m above the ground', icon: 'wind' },
  GWETTOP: { change: 'wetter at the soil surface', sub: 'How wet the top layer of soil is', icon: 'sprout' },
  EVLAND: { change: 'more evaporation', sub: 'Water evaporating from land and plants', icon: 'leaf' },
}

const PICKER_TITLE: Record<Kind, string> = { region: 'Choose a place', variable: 'Choose what to look at', window: 'Choose a span of years', season: 'Choose a time of year' }

export default function AskSentence() {
  const { regionId, variableId, windowId, season } = useStore()
  const { setRegion, setVariable, setWindow, setSeason } = useStore()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [presets, setPresets] = useState<Presets | null>(null)
  const [open, setOpen] = useState<{ kind: Kind; left: number; top: number; width: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const chipRefs = useRef<Partial<Record<Kind, HTMLButtonElement | null>>>({})

  useEffect(() => {
    let live = true
    loadCatalog().then((c) => live && setCatalog(c)).catch(() => {})
    loadPresets().then((p) => live && setPresets(p)).catch(() => {})
    return () => { live = false }
  }, [])

  // True when a region x variable x season has at least one real value. Unknown (not loaded, drawn region) counts as available.
  const hasData = (v: string, s: string, r: string) => {
    if (!presets || r === 'custom') return true
    const e = presets[v]?.[s]?.[r]
    return !!e && e.values.some((x) => x != null)
  }

  const varMeta = (id: string) => catalog?.variables.find((v) => v.id === id)
  const windowPhrase = (id: string) => spanPhrase(catalog?.windows.find((x) => x.id === id))
  const seasonPhrase = (id: string) => seasonPhraseOf(id, catalog?.seasons[id]?.label)
  const regionPlace = (id: string) => place(id, catalog?.regions.find((r) => r.id === id)?.name)
  const regionPhrase = (id: string) => regionPlace(id).mid

  const options = useMemo<Record<Kind, Opt[]>>(() => {
    const vName = (varMeta(variableId)?.short_name ?? 'this variable').toLowerCase()
    return {
      region: (catalog?.regions ?? []).map((r) => {
        const ok = hasData(variableId, season, r.id)
        return {
          id: r.id, label: r.name, sub: ok ? r.description : `No ${vName} data for this place in the NASA record.`,
          icon: r.id === 'whole-earth' ? 'rings' : 'pin', disabled: !ok,
        } as Opt
      }),
      variable: (catalog?.variables ?? []).map((v) => {
        const copy = VARIABLE_COPY[v.id] ?? { change: 'different', sub: v.definition, icon: 'rings' as IconName }
        const ok = hasData(v.id, season, regionId)
        return {
          id: v.id, label: `${v.short_name}: ${copy.change}`, sub: ok ? copy.sub : 'No data for this place in the NASA record.',
          icon: copy.icon, disabled: !ok,
        } as Opt
      }),
      window: (catalog?.windows ?? []).map((w) => ({
        id: w.id, label: windowPhrase(w.id), sub: `${w.start}–${w.end}${w.id === 'full' ? ', the full record' : ''}`, icon: 'rings' as IconName,
      })),
      season: Object.entries(catalog?.seasons ?? {}).map(([id, s]) => {
        const ok = hasData(variableId, id, regionId)
        return {
          id, label: seasonPhrase(id), sub: ok ? (id === 'annual' ? 'Every month, January to December' : s.label) : 'No data for this place in the NASA record.',
          icon: 'sun' as IconName, disabled: !ok,
        } as Opt
      }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, presets, regionId, variableId, season])

  const currentId: Record<Kind, string> = { region: regionId, variable: variableId, window: windowId, season }

  const close = (refocus: boolean) => {
    const k = open?.kind
    setOpen(null)
    if (refocus && k) chipRefs.current[k]?.focus()
  }

  const toggle = (kind: Kind) => {
    if (open?.kind === kind) return close(false)
    const chip = chipRefs.current[kind], box = boxRef.current
    if (!chip || !box) return
    const c = chip.getBoundingClientRect(), b = box.getBoundingClientRect()
    const width = Math.min(kind === 'region' || kind === 'variable' ? 380 : 340, b.width)
    setOpen({ kind, width, left: Math.max(0, Math.min(c.left - b.left, b.width - width)), top: c.bottom - b.top + 8 })
  }

  // focus the selected (or first enabled) option when a picker opens
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const target = list.querySelector<HTMLElement>('[aria-selected="true"]:not([aria-disabled="true"])') ?? list.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  }, [open?.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  // outside pointer and resize close the picker
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(null) }
    const resize = () => setOpen(null)
    document.addEventListener('pointerdown', down)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('resize', resize) }
  }, [open])

  const pick = (kind: Kind, o: Opt) => {
    if (o.disabled) return
    if (kind === 'region') setRegion(o.id, null)
    else if (kind === 'variable') setVariable(o.id)
    else if (kind === 'window') setWindow(o.id)
    else setSeason(o.id)
    close(true)
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return }
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [])]
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(items.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = i < 0 ? 0 : Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next >= 0) { e.preventDefault(); items[next].focus() }
  }

  const onChipKey = (e: React.KeyboardEvent, kind: Kind) => {
    if (e.key === 'ArrowDown' && open?.kind !== kind) { e.preventDefault(); toggle(kind) }
    else if (e.key === 'Escape' && open) { setOpen(null) }
  }

  const chip = (kind: Kind, text: string) => (
    <button
      type="button"
      className="chip"
      ref={(el) => { chipRefs.current[kind] = el }}
      aria-haspopup="listbox"
      aria-expanded={open?.kind === kind}
      aria-controls={open?.kind === kind ? `ask-list-${kind}` : undefined}
      onClick={() => toggle(kind)}
      onKeyDown={(e) => onChipKey(e, kind)}
    >
      <span>{text}</span><Icon name="chev" />
    </button>
  )

  const copy = VARIABLE_COPY[variableId]
  const opts = open ? options[open.kind] : []

  return (
    <div className="sentence-box" ref={boxRef}>
      <p className="sentence" id="sentence">
        {regionPlace(regionId).Is} {chip('region', regionPhrase(regionId))} getting {chip('variable', copy?.change ?? varMeta(variableId)?.short_name ?? variableId)} over{' '}
        {chip('window', windowPhrase(windowId))} {chip('season', seasonPhrase(season))}?
      </p>
      {open && (
        <div
          className="picker"
          style={{ left: open.left, top: open.top, width: open.width }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null
            if (to && !boxRef.current?.contains(to)) setOpen(null)
          }}
        >
          <div
            ref={listRef}
            id={`ask-list-${open.kind}`}
            role="listbox"
            aria-label={PICKER_TITLE[open.kind]}
            onKeyDown={onListKey}
          >
            {opts.length === 0 && <p className="picker-empty note">The catalog is still loading.</p>}
            {opts.map((o) => {
              const selected = o.id === currentId[open.kind]
              return (
                <button
                  type="button"
                  key={o.id}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={o.disabled || undefined}
                  tabIndex={selected && !o.disabled ? 0 : -1}
                  onClick={() => pick(open.kind, o)}
                >
                  <Icon name={o.icon} />
                  <span>{o.label}</span>
                  <small>{o.sub}</small>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
