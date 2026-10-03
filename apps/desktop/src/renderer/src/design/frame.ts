import tailwindUrl from '@tailwindcss/browser?url'
import type { Artboard, NodeRef, Rect, View } from './model'
import { newId } from './model'

/**
 * The document the designs live in: one same-origin iframe holding every
 * artboard as real DOM, styled by Tailwind's browser build. The iframe takes
 * no pointer events (except while text is edited); the app's overlay sits on
 * top and asks this class what is under the pointer and where things are.
 *
 * Rects from `getBoundingClientRect` in here are in the iframe's viewport,
 * which is exactly the overlay's coordinate space.
 */

const BASE_CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; }
body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; cursor: default; }
#pl-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.pl-board { position: absolute;
  box-shadow: 0 0 0 1px rgba(20, 20, 30, 0.08), 0 12px 32px rgba(20, 20, 30, 0.08); }
.pl-root { position: relative; width: 100%; height: 100%; overflow: hidden; color: #111; }
.pl-root img { -webkit-user-drag: none; }
.pl-root [contenteditable] { outline: none; cursor: text; user-select: text; -webkit-user-select: text; }
.pl-root [data-pl-ghost] { opacity: 0.35; }
.pl-reveal { animation: pl-reveal 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
@keyframes pl-reveal { from { filter: blur(18px); opacity: 0; } to { filter: blur(0); opacity: 1; } }
.pl-flash { animation: pl-flash 0.9s ease-out both; }
@keyframes pl-flash { from { box-shadow: 0 0 0 3px var(--pl-flash, #7c5cd6), 0 0 0 9px color-mix(in srgb, var(--pl-flash, #7c5cd6) 25%, transparent); } to { box-shadow: 0 0 0 3px transparent, 0 0 0 16px transparent; } }
`

const EDITOR_ATTRS = ['contenteditable', 'data-pl-ghost', 'spellcheck']
const TEXT_INLINE = new Set(['B', 'I', 'U', 'EM', 'STRONG', 'SPAN', 'BR', 'A', 'SMALL', 'SUP', 'SUB'])
const NO_CHILDREN = new Set(['IMG', 'SVG', 'svg', 'INPUT', 'HR', 'BR', 'VIDEO', 'CANVAS', 'TEXTAREA'])

export class CanvasFrame {
  readonly doc: Document
  readonly world: HTMLElement
  private mounted = new Map<string, string>()
  private fontLinks = new Map<string, HTMLLinkElement>()
  ready: Promise<void>

  constructor(readonly iframe: HTMLIFrameElement) {
    const doc = iframe.contentDocument
    if (!doc) throw new Error('canvas frame has no document')
    this.doc = doc
    doc.open()
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    doc.close()
    const style = doc.createElement('style')
    style.id = 'pl-base'
    style.textContent = BASE_CSS
    doc.head.appendChild(style)
    this.world = doc.createElement('div')
    this.world.id = 'pl-world'
    doc.body.appendChild(this.world)
    this.ready = new Promise((resolve) => {
      const script = doc.createElement('script')
      script.src = tailwindUrl
      script.onload = () => resolve()
      script.onerror = () => resolve()
      doc.head.appendChild(script)
    })
  }

  setBackground(color: string): void {
    this.doc.body.style.background = color
  }

  setView(view: View): void {
    this.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
  }

  // ---------- artboards ----------

  board(id: string): HTMLElement | null {
    return this.world.querySelector<HTMLElement>(`.pl-board[data-board="${id}"]`)
  }

  root(id: string): HTMLElement | null {
    return this.board(id)?.firstElementChild as HTMLElement | null
  }

  /** Make the DOM match the document; content is only replaced when it differs. */
  mount(artboards: Artboard[]): void {
    const wanted = new Set(artboards.map((b) => b.id))
    for (const el of Array.from(this.world.children)) {
      const id = (el as HTMLElement).dataset.board
      if (id && !wanted.has(id)) {
        el.remove()
        this.mounted.delete(id)
      }
    }
    artboards.forEach((b, index) => {
      let el = this.board(b.id)
      if (!el) {
        el = this.doc.createElement('div')
        el.className = 'pl-board'
        el.dataset.board = b.id
        const root = this.doc.createElement('div')
        root.className = 'pl-root'
        el.appendChild(root)
        this.world.appendChild(el)
      }
      if (this.world.children[index] !== el) this.world.insertBefore(el, this.world.children[index])
      el.style.left = `${b.x}px`
      el.style.top = `${b.y}px`
      el.style.width = `${b.width}px`
      el.style.height = `${b.height}px`
      const root = el.firstElementChild as HTMLElement
      root.style.background = b.background
      if (this.mounted.get(b.id) !== b.html) {
        root.innerHTML = b.html
        this.ensureIds(root)
        this.mounted.set(b.id, b.html)
      }
    })
  }

  /** The artboard's content as stored: live DOM minus editor-only attributes. */
  serialize(id: string): string {
    const root = this.root(id)
    if (!root) return ''
    this.ensureIds(root)
    const html = cleanClone(root).innerHTML.trim()
    this.mounted.set(id, html)
    return html
  }

  ensureIds(scope: Element): void {
    const seen = new Set<string>()
    const walk = (el: Element): void => {
      for (const child of Array.from(el.children)) {
        const id = child.getAttribute('data-id')
        if (!id || seen.has(id)) child.setAttribute('data-id', newId())
        seen.add(child.getAttribute('data-id') as string)
        if (child.tagName.toLowerCase() !== 'svg') walk(child)
      }
    }
    walk(scope)
  }

  // ---------- nodes ----------

  node(ref: NodeRef): HTMLElement | null {
    const root = this.root(ref.boardId)
    if (!root) return null
    if (ref.nodeId === null) return root
    return root.querySelector<HTMLElement>(`[data-id="${ref.nodeId}"]`)
  }

  refOf(el: Element | null): NodeRef | null {
    let cur: Element | null = el
    while (cur && !cur.classList.contains('pl-root')) {
      const id = cur.getAttribute('data-id')
      const board = id ? cur.closest<HTMLElement>('.pl-board') : null
      if (id && board?.dataset.board) return { boardId: board.dataset.board, nodeId: id }
      cur = cur.parentElement
    }
    const board = cur?.closest<HTMLElement>('.pl-board')
    return board?.dataset.board ? { boardId: board.dataset.board, nodeId: null } : null
  }

  /** The frame's own window: computed styles must come from here. */
  get view(): Window & typeof globalThis {
    return this.doc.defaultView as Window & typeof globalThis
  }

  /** The node under a point in overlay coordinates. */
  hit(x: number, y: number): NodeRef | null {
    return this.refOf(this.doc.elementFromPoint(x, y))
  }

  rect(ref: NodeRef): Rect | null {
    const el = ref.nodeId === null ? this.board(ref.boardId) : this.node(ref)
    return el ? toRect(el.getBoundingClientRect()) : null
  }

  /** The stylesheet Tailwind generated for the classes on the canvas. */
  compiledCss(): string {
    return Array.from(this.doc.head.querySelectorAll('style'))
      .filter((s) => s.id !== 'pl-base' && s.getAttribute('type') !== 'text/tailwindcss')
      .map((s) => s.textContent ?? '')
      .join('\n')
  }

  // ---------- fonts ----------

  setFonts(families: string[]): void {
    for (const [name, link] of this.fontLinks) {
      if (!families.includes(name)) {
        link.remove()
        this.fontLinks.delete(name)
      }
    }
    for (const family of families) {
      if (this.fontLinks.has(family)) continue
      const link = this.doc.createElement('link')
      link.rel = 'stylesheet'
      // Variable weights first; static families refuse a range, so step down.
      const tries = [':wght@100..900', ':wght@400;700', '']
      const load = (i: number): void => {
        link.href = fontHref(family, tries[i])
        link.onerror = i + 1 < tries.length ? () => load(i + 1) : null
      }
      load(0)
      this.doc.head.appendChild(link)
      this.fontLinks.set(family, link)
    }
  }
}

export function fontHref(family: string, axis = ''): string {
  return `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}${axis}&display=swap`
}

export function toRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** A copy of a node without the attributes the editor adds while working. */
export function cleanClone<T extends Element>(el: T): T {
  const clone = el.cloneNode(true) as T
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attr of EDITOR_ATTRS) node.removeAttribute(attr)
    node.classList.remove('pl-reveal', 'pl-flash')
    ;(node as HTMLElement).style?.removeProperty('--pl-flash')
    if (node.getAttribute('class') === '') node.removeAttribute('class')
    if (node.getAttribute('style') === '') node.removeAttribute('style')
  }
  return clone
}

/** Holds only text (and inline markup): double-click edits it in place. */
export function isTextLeaf(el: Element): boolean {
  if (NO_CHILDREN.has(el.tagName)) return false
  if (!el.textContent?.trim() && el.children.length === 0) return false
  return Array.from(el.children).every((c) => TEXT_INLINE.has(c.tagName) && isInlineOnly(c))
}

function isInlineOnly(el: Element): boolean {
  return Array.from(el.children).every((c) => TEXT_INLINE.has(c.tagName) && isInlineOnly(c))
}

/** Can other nodes be dropped into it? */
export function isContainer(el: Element): boolean {
  if (NO_CHILDREN.has(el.tagName)) return false
  if (el.closest('svg')) return false
  if (el.classList.contains('pl-root')) return true
  return !(isTextLeaf(el) && !!el.textContent?.trim())
}

export function isAbsolute(el: Element): boolean {
  const position = el.ownerDocument.defaultView?.getComputedStyle(el).position
  return position === 'absolute' || position === 'fixed'
}

/** Rotation of an element in degrees, from `rotate` and `transform`. */
export function rotationOf(el: Element): number {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!cs) return 0
  let deg = 0
  const rotate = cs.rotate
  if (rotate && rotate !== 'none') {
    const m = rotate.match(/(-?[\d.]+)(deg|rad|turn)/)
    if (m) deg += m[2] === 'deg' ? +m[1] : m[2] === 'rad' ? (+m[1] * 180) / Math.PI : +m[1] * 360
  }
  const t = cs.transform
  if (t && t !== 'none') {
    const m = t.match(/matrix\(([^)]+)\)/)
    if (m) {
      const [a, b] = m[1].split(',').map(Number)
      deg += (Math.atan2(b, a) * 180) / Math.PI
    }
  }
  return deg
}

/** Rotation including every rotated ancestor, for drawing the selection box. */
export function totalRotation(el: Element): number {
  let deg = 0
  let cur: Element | null = el
  while (cur && !cur.classList.contains('pl-root')) {
    deg += rotationOf(cur)
    cur = cur.parentElement
  }
  return deg
}
