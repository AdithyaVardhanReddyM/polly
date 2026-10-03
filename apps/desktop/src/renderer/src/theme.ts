import { useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'polly.theme'
const BACKGROUND = { light: '#fafafb', dark: '#111114' }

/** Light unless the user chose dark, or chose to follow the system. */
function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'system' ? v : 'light'
  } catch {
    return 'light'
  }
}

const media = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

function apply(pref: ThemePref): void {
  const resolved = pref === 'system' ? (media().matches ? 'dark' : 'light') : pref
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  void window.polly?.setBackgroundColor?.(BACKGROUND[resolved])
}

const listeners = new Set<(p: ThemePref) => void>()

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === 'light') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    /* storage can be unavailable */
  }
  apply(pref)
  listeners.forEach((l) => l(pref))
}

/** Apply the saved theme now, and follow the OS while on "system". */
export function initTheme(): void {
  apply(read())
  media().addEventListener('change', () => {
    if (read() === 'system') apply('system')
  })
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read)
  useEffect(() => {
    listeners.add(setPref)
    return () => {
      listeners.delete(setPref)
    }
  }, [])
  return [pref, setTheme]
}
