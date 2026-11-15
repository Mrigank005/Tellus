/** Authored icon set (1.5px stroke, 24px grid). Render <IconSprite/> once; use <Icon name=…/> anywhere. */
export type IconName =
  | 'rings' | 'sprout' | 'sun' | 'drop' | 'wind' | 'thermo' | 'leaf' | 'sat' | 'shuffle'
  | 'check' | 'tilde' | 'x' | 'arrow' | 'book' | 'chev' | 'pin' | 'moon' | 'pen'

export function Icon({ name, className = '', size, title }: { name: IconName; className?: string; size?: number; title?: string }) {
  const style = size ? { width: size, height: size } : undefined
  return (
    <svg className={`icon ${className}`} style={style} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <use href={`#i-${name}`} />
    </svg>
  )
}

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <symbol id="i-rings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" /><path d="M12 5.5c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5-6.5-2.9-6.5-6.5" /><path d="M12 9a3 3 0 1 1-3 3" /><circle cx="12" cy="12" r=".6" fill="currentColor" /></symbol>
        <symbol id="i-sprout" viewBox="0 0 24 24"><path d="M12 21v-9" /><path d="M12 12c0-4 3-6.5 7-6.5 0 4-3 6.5-7 6.5Z" /><path d="M12 14.5c0-3-2.3-5-5.5-5 0 3 2.3 5 5.5 5Z" /><path d="M8 21h8" /></symbol>
        <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></symbol>
        <symbol id="i-drop" viewBox="0 0 24 24"><path d="M12 3.5s-6 6.6-6 10.7A6 6 0 0 0 18 14.2C18 10.1 12 3.5 12 3.5Z" /><path d="M9.5 15a2.6 2.6 0 0 0 2.5 2.4" /></symbol>
        <symbol id="i-wind" viewBox="0 0 24 24"><path d="M3 9h11a3 3 0 1 0-3-3" /><path d="M3 14h15a3 3 0 1 1-3 3" /><path d="M3 19h6" /></symbol>
        <symbol id="i-thermo" viewBox="0 0 24 24"><path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0Z" /><path d="M12 9v7" /></symbol>
        <symbol id="i-leaf" viewBox="0 0 24 24"><path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15" /><path d="M5 19 13 11" /></symbol>
        <symbol id="i-sat" viewBox="0 0 24 24"><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M2.5 9.5h5v5h-5zM16.5 9.5h5v5h-5zM7.5 12h2M14.5 12h2M12 9.5V6.5" /><path d="M9 4.5a4 4 0 0 1 6 0" /></symbol>
        <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M3 7h3.5c4 0 6 10 10 10H21" /><path d="M3 17h3.5c1.6 0 2.8-1.6 3.8-3.6M14 9.6C15 8.1 15.8 7 16.5 7H21" /><path d="m18.5 4.5 2.5 2.5-2.5 2.5M18.5 14.5l2.5 2.5-2.5 2.5" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></symbol>
        <symbol id="i-tilde" viewBox="0 0 24 24"><path d="M5 13c2-3 4-3 7 0s5 3 7 0" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></symbol>
        <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></symbol>
        <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 5.5C6.5 4.5 9.5 4.5 12 6v13c-2.5-1.5-5.5-1.5-8-.5Z" /><path d="M20 5.5c-2.5-1-5.5-1-8 .5v13c2.5-1.5 5.5-1.5 8-.5Z" /></symbol>
        <symbol id="i-chev" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" /></symbol>
        <symbol id="i-pin" viewBox="0 0 24 24"><circle cx="12" cy="9" r="4.5" /><path d="M12 13.5V21" /></symbol>
        <symbol id="i-moon" viewBox="0 0 24 24"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" /></symbol>
        <symbol id="i-pen" viewBox="0 0 24 24"><path d="M4 20l4-1 10-10-3-3L5 16z" /><path d="M13.5 7.5l3 3" /></symbol>
      </defs>
    </svg>
  )
}
