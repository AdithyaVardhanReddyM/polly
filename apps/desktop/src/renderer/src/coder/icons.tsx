/**
 * Icons with meaning: Material Icon Theme for files and folders (the same
 * mapping VS Code users know), and each model vendor's own logo.
 */
import {
  fileExtensions,
  fileNames,
  folderNames,
  folderNamesExpanded,
  light
} from 'material-icon-theme/dist/material-icons.json'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw'
import kimiColor from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?raw'
import nebius from '@lobehub/icons-static-svg/icons/nebius.svg?raw'
import nvidia from '@lobehub/icons-static-svg/icons/nvidia-color.svg?raw'
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw'
import { useSyncExternalStore } from 'react'

// Every icon ships as its own small file; only the ones on screen load.
const ICON_URLS = import.meta.glob<string>('../../../../node_modules/material-icon-theme/icons/*.svg', {
  query: '?url',
  import: 'default',
  eager: true
})

const URL_BY_NAME = new Map(
  Object.entries(ICON_URLS).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url])
)

type Lookup = Record<string, string | undefined>
const EXT = fileExtensions as Lookup
const NAMES = fileNames as Lookup
const FOLDERS = folderNames as Lookup
const FOLDERS_OPEN = folderNamesExpanded as Lookup
const LIGHT = light as { fileExtensions?: Lookup; fileNames?: Lookup; folderNames?: Lookup; folderNamesExpanded?: Lookup }

// One observer for every icon on screen: some themes swap icons in light mode.
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => themeListeners.forEach((l) => l()))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
    }
  }
}

const useDark = (): boolean =>
  useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme === 'dark')

/** The icon for a file name: exact names first, then the longest extension. */
function fileIconName(name: string, dark: boolean): string {
  const lower = name.toLowerCase()
  const exact = (!dark && LIGHT.fileNames?.[lower]) || NAMES[lower]
  if (exact) return exact
  // "app.test.ts" tries "test.ts" before "ts".
  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    const hit = (!dark && LIGHT.fileExtensions?.[ext]) || EXT[ext]
    if (hit) return hit
  }
  return 'file'
}

function folderIconName(name: string, open: boolean, dark: boolean): string {
  const lower = name.toLowerCase()
  const table = open ? FOLDERS_OPEN : FOLDERS
  const lightTable = open ? LIGHT.folderNamesExpanded : LIGHT.folderNames
  return (!dark && lightTable?.[lower]) || table[lower] || (open ? 'folder-open' : 'folder')
}

function iconUrl(name: string, fallback: string): string | undefined {
  return URL_BY_NAME.get(name) ?? URL_BY_NAME.get(fallback)
}

export function FileIcon({ name, className }: { name: string; className?: string }): React.JSX.Element {
  const dark = useDark()
  return (
    <img
      className={`ficon${className ? ` ${className}` : ''}`}
      src={iconUrl(fileIconName(name, dark), 'file')}
      alt=""
      draggable={false}
    />
  )
}

export function FolderIcon({ name, open }: { name: string; open: boolean }): React.JSX.Element {
  const dark = useDark()
  return (
    <img
      className="ficon"
      src={iconUrl(folderIconName(name, open, dark), open ? 'folder-open' : 'folder')}
      alt=""
      draggable={false}
    />
  )
}

// ---------- model vendors ----------

// Kimi's colour mark draws its "K" in white for dark tiles; let it follow the
// text colour instead, keeping the blue dot.
const kimi = kimiColor.replace('fill="#fff"', 'fill="currentColor"')

const VENDOR_LOGOS: Record<string, string> = {
  nvidia,
  'z.ai': zai,
  deepseek,
  moonshot
}

/** Kimi models wear Kimi's mark rather than Moonshot's. */
function logoFor(vendor: string, model?: string): string | undefined {
  if (model && /kimi/i.test(model)) return kimi
  return VENDOR_LOGOS[vendor.toLowerCase()]
}

export function ModelLogo({
  vendor,
  model,
  size = 16
}: {
  vendor: string
  model?: string
  size?: number
}): React.JSX.Element {
  const svg = logoFor(vendor, model)
  if (!svg) {
    return (
      <span className="vendor-logo is-letter" style={{ width: size, height: size, fontSize: size * 0.6 }}>
        {vendor.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <span
      className="vendor-logo"
      style={{ width: size, height: size }}
      aria-label={vendor}
      // The SVGs come from the package, not from anything user-supplied.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export function NebiusLogo({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="vendor-logo"
      style={{ width: size, height: size }}
      aria-label="Nebius"
      dangerouslySetInnerHTML={{ __html: nebius }}
    />
  )
}
