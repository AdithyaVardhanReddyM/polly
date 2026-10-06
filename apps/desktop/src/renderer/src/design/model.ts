/** The design document, as the server stores it (`design/document.py`). */
export interface Artboard {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  background: string
  html: string
}

export interface DesignDoc {
  rev: number
  artboards: Artboard[]
  fonts: string[]
  selection: { artboard_id: string; node_id: string | null }[]
}

/** A node on the canvas; `nodeId: null` is the artboard itself. */
export interface NodeRef {
  boardId: string
  nodeId: string | null
}

export interface View {
  x: number
  y: number
  zoom: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Tool = 'select' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text'

/**
 * The layers drawn outside any frame live in one artboard with this id. It sits
 * at the canvas origin with no size and never clips, so its children are placed
 * in canvas coordinates, like top-level layers in Figma. It is never selected
 * or labelled as a frame itself.
 */
export const CANVAS_ID = 'canvas'
export const isLoose = (boardId: string): boolean => boardId === CANVAS_ID

export const sameRef = (a: NodeRef | null, b: NodeRef | null): boolean =>
  !!a && !!b && a.boardId === b.boardId && a.nodeId === b.nodeId

export const refKey = (r: NodeRef): string => `${r.boardId}/${r.nodeId ?? ''}`

export const newId = (prefix = 'n'): string =>
  prefix + Math.random().toString(16).slice(2, 8).padEnd(6, '0')

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export const round = (v: number, step = 1): number => Math.round(v / step) * step

export const PRESETS: { group: string; name: string; width: number; height: number }[] = [
  { group: 'Screens', name: 'Phone', width: 390, height: 844 },
  { group: 'Screens', name: 'Tablet', width: 834, height: 1194 },
  { group: 'Screens', name: 'Desktop', width: 1440, height: 900 },
  { group: 'Screens', name: 'Landing page', width: 1440, height: 2400 },
  { group: 'Social', name: 'Square post', width: 1080, height: 1080 },
  { group: 'Social', name: 'Story', width: 1080, height: 1920 },
  { group: 'Social', name: 'Wide banner', width: 1600, height: 900 },
  { group: 'Print', name: 'Poster', width: 1240, height: 1754 },
  { group: 'Print', name: 'Flyer', width: 1275, height: 1650 }
]

export const FONTS = [
  'Inter',
  'Geist',
  'DM Sans',
  'Manrope',
  'Plus Jakarta Sans',
  'Space Grotesk',
  'Outfit',
  'Sora',
  'Poppins',
  'Montserrat',
  'Bricolage Grotesque',
  'Instrument Serif',
  'Fraunces',
  'Playfair Display',
  'DM Serif Display',
  'Cormorant Garamond',
  'Libre Baskerville',
  'Bebas Neue',
  'Anton',
  'Archivo Black',
  'Syne',
  'Unbounded',
  'JetBrains Mono',
  'IBM Plex Mono',
  'Caveat'
]

/** One colour per artboard the agent is working on, like collaborators' cursors. */
export const AGENT_COLORS = ['#2f6fb3', '#c2185b', '#2e8b5e', '#c26a12', '#7c5cd6', '#0f8b8d']
