/**
 * The artwork on an agent's ID card: the front (robot, name, tagline, what
 * it can do), the back and the strap, each drawn on a 2D canvas that the
 * lanyard maps onto the card.
 */
import { Avatar, Style } from '@dicebear/core'
import definition from '@dicebear/styles/voxel-bot.json'
import mark from '../assets/polly-mark.svg'
import { FACE_ASPECT } from './face'

const style = new Style(definition as ConstructorParameters<typeof Style>[0])

const WIDTH = 720
const HEIGHT = Math.round(WIDTH / FACE_ASPECT)
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif'

// The card is an object, not a surface of the app: it keeps its own colours
// in both themes.
const PAPER = '#ffffff'
const INK = '#1c1b22'
const MUTED = '#6b6a75'
const BRAND_INK = '#4b3a8c'
const TINT = '#efe8ff'

export interface Badge {
  name: string
  tagline: string
  avatar: Record<string, string>
  /** Short labels for what the agent can do: "Web search", "Sandbox"… */
  abilities: string[]
  /** The model's short name. */
  model: string
}

export function faceCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  return canvas
}

function image(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

const robots = new Map<string, Promise<HTMLImageElement | null>>()

/** The agent's robot as an image, still and without a tile behind it. */
function robot(avatar: Record<string, string>): Promise<HTMLImageElement | null> {
  const key = JSON.stringify(avatar)
  let found = robots.get(key)
  if (!found) {
    const uri = new Avatar(style, {
      backgroundColor: ['00000000'],
      ...avatar,
      animationVariant: 'none',
      size: 512
    }).toDataUri()
    found = image(uri)
    robots.set(key, found)
    if (robots.size > 40) robots.delete(robots.keys().next().value as string)
  }
  return found
}

let logo: Promise<HTMLImageElement | null> | null = null
const pollyMark = (): Promise<HTMLImageElement | null> => (logo ??= image(mark))

/** Shrink the font until `text` fits `width`; returns the size used. */
function fit(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: (size: number) => string,
  size: number,
  min: number,
  width: number
): number {
  for (let s = size; s >= min; s -= 2) {
    ctx.font = font(s)
    if (ctx.measureText(text).width <= width) return s
  }
  ctx.font = font(min)
  return min
}

/** `text` broken into at most `lines` lines of `width`, the last one cut with an ellipsis. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= width || !line) {
      line = next
      continue
    }
    out.push(line)
    line = word
    if (out.length === lines) break
  }
  if (out.length < lines && line) out.push(line)
  else if (line && out.length === lines) {
    let last = out[lines - 1]
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1)
    out[lines - 1] = `${last.trimEnd()}…`
  }
  return out
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, h / 2)
  ctx.fill()
}

/** Draw the front of the card. `stale` is asked once the images are in: a
 *  draw that a newer one has overtaken leaves the canvas alone. */
export async function drawFront(
  canvas: HTMLCanvasElement,
  badge: Badge,
  stale: () => boolean = () => false
): Promise<boolean> {
  const [bot, polly] = await Promise.all([robot(badge.avatar), pollyMark()])
  if (stale()) return false
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const W = canvas.width
  const H = canvas.height
  const pad = 52

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, W, H)

  // The slot the clip passes through sits at the top; keep the header below it.
  const top = 150
  if (polly) {
    const h = 44
    ctx.drawImage(polly, pad, top, (polly.width / polly.height) * h, h)
  }
  ctx.fillStyle = INK
  ctx.font = `600 40px ${SANS}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('Polly', pad + 88, top + 24)
  ctx.textAlign = 'right'
  ctx.fillStyle = MUTED
  ctx.font = `500 34px ${SANS}`
  ctx.fillText('Agent', W - pad, top + 24)

  // The robot, on the tint custom agents share.
  const tile = W - pad * 2
  const tileY = top + 84
  const tileH = 350
  ctx.fillStyle = TINT
  ctx.beginPath()
  ctx.roundRect(pad, tileY, tile, tileH, 36)
  ctx.fill()
  if (bot) {
    const size = 310
    ctx.drawImage(bot, (W - size) / 2, tileY + (tileH - size) / 2 + 6, size, size)
  }

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  const name = badge.name.trim() || 'New agent'
  ctx.fillStyle = badge.name.trim() ? INK : MUTED
  const nameSize = fit(ctx, name, (s) => `700 ${s}px ${SANS}`, 84, 48, tile)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '-2px'
  const nameY = tileY + tileH + 44 + nameSize * 0.8
  ctx.fillText(name, pad, nameY)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'

  ctx.fillStyle = MUTED
  ctx.font = `400 40px ${SANS}`
  const tagline = badge.tagline.trim() || 'What does it do?'
  let y = nameY + 64
  for (const line of wrap(ctx, tagline, tile, 2)) {
    ctx.fillText(line, pad, y)
    y += 52
  }

  // What it can do, as pills along the bottom; the model under them.
  const footer = H - 62
  const row = footer - 74
  ctx.font = `500 32px ${SANS}`
  ctx.textBaseline = 'middle'
  let x = pad
  for (const label of badge.abilities) {
    const w = ctx.measureText(label).width + 44
    if (x + w > W - pad) break // one row only
    ctx.fillStyle = TINT
    pill(ctx, x, row - 29, w, 58)
    ctx.fillStyle = BRAND_INK
    ctx.fillText(label, x + 22, row + 1)
    x += w + 12
  }
  ctx.fillStyle = MUTED
  ctx.font = `400 30px ${SANS}`
  ctx.fillText(badge.model, pad, footer)
  return true
}

/** The back: the mark, large, on the brand colour. */
export async function drawBack(canvas: HTMLCanvasElement): Promise<void> {
  const polly = await pollyMark()
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.fillStyle = BRAND_INK
  ctx.fillRect(0, 0, W, H)
  if (polly) {
    const w = 260
    const h = (polly.height / polly.width) * w
    ctx.drawImage(polly, (W - w) / 2, H / 2 - h - 10, w, h)
  }
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 80px ${SANS}`
  ctx.fillText('Polly', W / 2, H / 2 + 104)
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = `400 26px ${SANS}`
  ctx.fillText('A workspace of agents', W / 2, H / 2 + 164)
}

/** The strap: deep purple with the mark repeated along it. */
export async function strapCanvas(): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = BRAND_INK
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const polly = await pollyMark()
  if (polly) {
    const h = 110
    const w = (polly.width / polly.height) * h
    ctx.drawImage(polly, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
  }
  return canvas
}
