import { snapdom } from '@zumer/snapdom'
import { cleanClone, fontHref, type CanvasFrame } from './frame'
import type { Artboard } from './model'

/**
 * Getting designs out: the document is already HTML + Tailwind, so code
 * export is printing the DOM in the wanted dialect, and image export is a
 * snapshot of the same nodes.
 */

export type CodeFormat = 'tailwind' | 'html' | 'jsx'
export type ImageFormat = 'png' | 'svg'

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'stop', 'use'])
const DROP_ATTRS = new Set(['data-id', 'data-name', 'data-lucide', 'data-stroke-width'])
const JSX_ATTRS: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  srcset: 'srcSet',
  crossorigin: 'crossOrigin',
  autocomplete: 'autoComplete',
  'xlink:href': 'xlinkHref',
  'xmlns:xlink': 'xmlnsXlink'
}

const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

function jsxAttr(name: string, value: string): string {
  if (name === 'style') {
    const entries = value
      .split(/;(?![^(]*\))/)
      .map((part) => {
        const i = part.indexOf(':')
        return i < 0 ? null : [part.slice(0, i).trim(), part.slice(i + 1).trim()]
      })
      .filter((e): e is [string, string] => !!e && !!e[0] && !!e[1])
      .map(([k, v]) => `${k.startsWith('--') ? `'${k}'` : camel(k)}: ${JSON.stringify(v)}`)
    return `style={{ ${entries.join(', ')} }}`
  }
  const key =
    JSX_ATTRS[name] ?? (name.startsWith('data-') || name.startsWith('aria-') ? name : camel(name))
  if (value === '') return key
  return value.includes('"') ? `${key}={${JSON.stringify(value)}}` : `${key}="${value}"`
}

function htmlAttr(name: string, value: string): string {
  return value === '' ? name : `${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
}

function text(value: string, jsx: boolean): string {
  const collapsed = value.replace(/\s+/g, ' ')
  if (jsx) return /[{}<>]/.test(collapsed) ? `{${JSON.stringify(collapsed)}}` : collapsed
  return collapsed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Pretty-print a DOM node as HTML or JSX. */
export function print(node: Element, jsx: boolean, depth = 0): string {
  const pad = '  '.repeat(depth)
  const tag = node.localName
  const attrs = Array.from(node.attributes)
    .filter((a) => !DROP_ATTRS.has(a.name))
    .map((a) => (jsx ? jsxAttr(a.name, a.value) : htmlAttr(a.name, a.value)))
  const open = `<${[tag, ...attrs].join(' ')}`
  const children = Array.from(node.childNodes).filter(
    (c) => c.nodeType === 1 || (c.nodeType === 3 && c.textContent?.trim())
  )
  if (children.length === 0) {
    if (VOID.has(tag)) return `${pad}${open}${jsx ? ' />' : '>'}`
    return jsx ? `${pad}${open} />` : `${pad}${open}></${tag}>`
  }
  if (children.every((c) => c.nodeType === 3)) {
    const inner = text(children.map((c) => c.textContent ?? '').join(''), jsx).trim()
    return `${pad}${open}>${inner}</${tag}>`
  }
  const inner = children.map((c) =>
    c.nodeType === 3
      ? `${pad}  ${text(c.textContent ?? '', jsx).trim()}`
      : print(c as Element, jsx, depth + 1)
  )
  return `${pad}${open}>\n${inner.join('\n')}\n${pad}</${tag}>`
}

/** What gets exported: one node, or an artboard wrapped in a frame of its size. */
function subject(frame: CanvasFrame, board: Artboard, nodeId: string | null): Element | null {
  if (nodeId) {
    const el = frame.root(board.id)?.querySelector(`[data-id="${nodeId}"]`)
    return el ? cleanClone(el) : null
  }
  const root = frame.root(board.id)
  if (!root) return null
  const wrapper = frame.doc.createElement('div')
  wrapper.className = `relative overflow-hidden w-[${Math.round(board.width)}px] h-[${Math.round(board.height)}px]`
  wrapper.style.background = board.background
  wrapper.innerHTML = cleanClone(root).innerHTML
  return wrapper
}

async function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Images live on the local server; a file that leaves the app carries them inside. */
async function inlineImages(el: Element): Promise<void> {
  const images = [el, ...Array.from(el.querySelectorAll('img'))].filter(
    (n): n is HTMLImageElement => n.localName === 'img'
  )
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(src)) return
      try {
        img.setAttribute('src', await dataUrl(await (await fetch(src)).blob()))
      } catch {
        /* the image stays a link */
      }
    })
  )
}

const componentName = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
    .replace(/^[0-9]+/, '') || 'Design'

export async function exportCode(
  frame: CanvasFrame,
  board: Artboard,
  nodeId: string | null,
  format: CodeFormat,
  fonts: string[]
): Promise<string> {
  const el = subject(frame, board, nodeId)
  if (!el) return ''
  if (format === 'tailwind') return print(el, false)
  if (format === 'jsx') {
    const body = print(el, true, 2)
    return `export default function ${componentName(nodeId ? 'Component' : board.name)}() {\n  return (\n${body}\n  )\n}\n`
  }
  await inlineImages(el)
  const links = fonts.map((f) => `    <link rel="stylesheet" href="${fontHref(f)}">`).join('\n')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${board.name.replace(/</g, '&lt;')}</title>
${links ? links + '\n' : ''}    <style>
${frame.compiledCss()}
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    </style>
  </head>
  <body>
${print(el, false, 2)}
  </body>
</html>
`
}

/** A picture of a node, as a data URL. `maxSide` caps the longest side in pixels. */
export async function capture(el: HTMLElement, format: ImageFormat, maxSide?: number): Promise<string> {
  const box = el.getBoundingClientRect()
  // The node is drawn at canvas zoom; ask for its real size.
  const natural = Math.max(el.offsetWidth || box.width, el.offsetHeight || box.height, 1)
  const scale = maxSide ? Math.min(1, maxSide / natural) : 2
  const shot = await snapdom(el, {
    // snapdom multiplies by the screen's pixel ratio; the size asked for is absolute.
    scale: format === 'svg' ? 1 : scale / (window.devicePixelRatio || 1),
    embedFonts: true,
    outerTransforms: false,
    outerShadows: false,
    cache: 'disabled'
  })
  return dataUrl(await shot.toBlob({ type: format }))
}

export function download(name: string, content: string | Blob, type = 'text/plain'): void {
  const isData = typeof content === 'string' && content.startsWith('data:')
  const url = isData
    ? (content as string)
    : URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (!isData) setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const fileName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'design'
