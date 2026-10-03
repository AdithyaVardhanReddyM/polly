/** Colours and gradients, between CSS strings and what the pickers edit. */

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export interface HSV {
  h: number
  s: number
  v: number
}

export interface Stop {
  color: string
  at: number
}

export interface Gradient {
  kind: 'linear' | 'radial'
  angle: number
  stops: Stop[]
}

export interface Shadow {
  x: number
  y: number
  blur: number
  spread: number
  color: string
  inset: boolean
}

let probe: CanvasRenderingContext2D | null = null

/** Any CSS colour (hex, rgb, oklch, a name…) as RGBA; null if it is not one. */
export function parseColor(input: string): RGBA | null {
  const value = input.trim().toLowerCase()
  if (!value || value === 'none') return null
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = value.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.replace(/./g, '$&$&')
    if (h.length !== 6 && h.length !== 8) return null
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length >= 3 && parts.every((p) => /^[\d.]+%?$/.test(p))) {
      const ch = (p: string): number => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p))
      const alpha = parts[3] ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1
      return { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: alpha }
    }
  }
  // Everything else (oklch, color-mix, names): let the browser resolve it.
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return null
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = '#000'
  probe.fillStyle = input
  const applied = probe.fillStyle
  if (applied === '#000000' && !/black|#000|rgb\(0|oklch\(0 /.test(value)) return null
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return { r, g, b, a: Math.round((a / 255) * 100) / 100 }
}

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')

export const toHex = (c: RGBA): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`

export function toCss(c: RGBA): string {
  if (c.a >= 0.995) return toHex(c)
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 100) / 100})`
}

export function toHsv({ r, g, b }: RGBA): HSV {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const d = max - Math.min(R, G, B)
  let h = 0
  if (d) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}

export function fromHsv({ h, s, v }: HSV, a = 1): RGBA {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255
  }
  return { r: f(5), g: f(3), b: f(1), a }
}

/** Split on commas that are not inside parentheses. */
export function splitTop(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const SIDES: Record<string, number> = {
  'to top': 0,
  'to top right': 45,
  'to right': 90,
  'to bottom right': 135,
  'to bottom': 180,
  'to bottom left': 225,
  'to left': 270,
  'to top left': 315
}

export function parseGradient(image: string): Gradient | null {
  const m = image.trim().match(/^(linear|radial)-gradient\((.*)\)$/s)
  if (!m) return null
  const parts = splitTop(m[2])
  let angle = 180
  const first = parts[0] ?? ''
  const direction = first.replace(/\s+in\s+.*$/, '').trim()
  const isDirection =
    /^-?[\d.]+(deg|turn|rad)$/.test(direction) ||
    direction.startsWith('to ') ||
    /^(circle|ellipse|closest|farthest|at )/.test(direction) ||
    first.startsWith('in ')
  if (isDirection) {
    parts.shift()
    if (direction.endsWith('deg')) angle = parseFloat(direction)
    else if (direction.endsWith('turn')) angle = parseFloat(direction) * 360
    else if (direction in SIDES) angle = SIDES[direction]
  }
  const stops = parts.map((part, i) => {
    const at = part.match(/\s(-?[\d.]+)%\s*$/)
    const color = (at ? part.slice(0, at.index) : part).trim()
    const rgba = parseColor(color)
    return {
      color: rgba ? toCss(rgba) : color,
      at: at ? parseFloat(at[1]) : parts.length > 1 ? (i / (parts.length - 1)) * 100 : 0
    }
  })
  if (stops.length < 2) return null
  return { kind: m[1] as Gradient['kind'], angle: ((angle % 360) + 360) % 360, stops }
}

export function formatGradient(g: Gradient): string {
  const stops = [...g.stops]
    .sort((a, b) => a.at - b.at)
    .map((s) => `${s.color} ${Math.round(s.at)}%`)
    .join(', ')
  return g.kind === 'linear'
    ? `linear-gradient(${Math.round(g.angle)}deg, ${stops})`
    : `radial-gradient(circle at center, ${stops})`
}

export function parseShadows(value: string): Shadow[] {
  if (!value || value === 'none') return []
  return splitTop(value).map((part) => {
    const inset = /\binset\b/.test(part)
    const colorMatch = part.match(/(rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i)
    const rest = part.replace(colorMatch?.[0] ?? '', '').replace('inset', '')
    const nums = (rest.match(/-?[\d.]+(px)?/g) ?? []).map(parseFloat)
    const rgba = colorMatch ? parseColor(colorMatch[0]) : null
    return {
      x: nums[0] ?? 0,
      y: nums[1] ?? 0,
      blur: nums[2] ?? 0,
      spread: nums[3] ?? 0,
      color: rgba ? toCss(rgba) : 'rgba(0, 0, 0, 0.2)',
      inset
    }
  })
}

export const formatShadows = (shadows: Shadow[]): string =>
  shadows
    .map((s) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`)
    .join(', ')
