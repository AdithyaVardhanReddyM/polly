import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { AgentPresence } from './AgentPresence'
import {
  CanvasFrame,
  cleanClone,
  isAbsolute,
  isContainer,
  isTextLeaf,
  rotationOf,
  toRect,
  totalRotation
} from './frame'
import { clamp, refKey, round, sameRef, type NodeRef, type Rect } from './model'
import { contains, snap, union, type Guide } from './snap'
import { attachFrame, getFrame, useCanvas } from './store'

/**
 * The canvas: the frame that renders the artboards, and on top of it the
 * overlay that takes every pointer event and draws selection, handles,
 * guides and the agent's cursors.
 */

const SNAP = 6 // screen pixels
const DRAG_START = 3
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

export const COMPONENT_MIME = 'application/x-polly-component'

interface Point {
  x: number
  y: number
}

interface DropTarget {
  container: HTMLElement
  before: Element | null
  line: Rect | null
  box: Rect
}

interface MoveItem {
  el: HTMLElement
  left: number
  top: number
}

type Drag =
  | { kind: 'pan'; start: Point; view: Point }
  | { kind: 'pending'; start: Point; hit: NodeRef | null; inside: boolean; shift: boolean; alt: boolean }
  | { kind: 'marquee'; start: Point; keep: NodeRef[] }
  | { kind: 'move'; start: Point; items: MoveItem[]; rect: Rect; targets: Rect[] }
  | { kind: 'reorder'; start: Point; el: HTMLElement; ref: NodeRef; rect: Rect; drop: DropTarget | null }
  | { kind: 'board'; start: Point; id: string; x: number; y: number; rect: Rect; targets: Rect[] }
  | {
      kind: 'resize'
      start: Point
      handle: Handle
      ref: NodeRef
      w: number
      h: number
      left: number
      top: number
      absolute: boolean
      own: number
      total: number
      rect: Rect
      targets: Rect[]
    }
  | { kind: 'rotate'; ref: NodeRef; center: Point; angle: number; base: number }
  | { kind: 'draw'; start: Point; tool: 'frame' | 'rect' | 'ellipse' }

interface Fx {
  guides: Guide[]
  marquee: Rect | null
  drop: DropTarget | null
  ghost: Rect | null
}

const NO_FX: Fx = { guides: [], marquee: null, drop: null, ghost: null }
const px = (v: string): number => parseFloat(v) || 0
const rectOf = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y)
})

function stripIds(el: Element): void {
  el.removeAttribute('data-id')
  el.querySelectorAll('[data-id]').forEach((n) => n.removeAttribute('data-id'))
}

/** The one element filling an artboard: dragging on it draws a marquee. */
function isBackdrop(el: HTMLElement): boolean {
  const parent = el.parentElement
  if (!parent?.classList.contains('pl-root') || isAbsolute(el)) return false
  return el.offsetWidth * el.offsetHeight >= parent.offsetWidth * parent.offsetHeight * 0.85
}

function layoutAxis(el: HTMLElement): 'x' | 'y' {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!cs) return 'y'
  if (cs.display.includes('flex')) return cs.flexDirection.startsWith('row') ? 'x' : 'y'
  if (cs.display.includes('grid')) return 'x'
  return 'y'
}

/** Where something dragged over `p` would land: a container and a sibling to go before. */
function dropTarget(frame: CanvasFrame, p: Point, dragged: Element | null): DropTarget | null {
  const under = frame.doc
    .elementsFromPoint(p.x, p.y)
    .find((e) => e.closest('.pl-root') && !(dragged && dragged.contains(e)))
  let container = under as HTMLElement | undefined | null
  while (container && !isContainer(container)) container = container.parentElement
  if (!container) return null

  // Close to a container's edge means "next to it", not "inside it".
  const parent = container.parentElement
  if (!container.classList.contains('pl-root') && parent && isContainer(parent) && !isAbsolute(container)) {
    const r = container.getBoundingClientRect()
    const edge = Math.min(8, r.width / 4, r.height / 4)
    const near =
      layoutAxis(parent) === 'x'
        ? p.x - r.left < edge || r.right - p.x < edge
        : p.y - r.top < edge || r.bottom - p.y < edge
    if (near) container = parent
  }

  const axis = layoutAxis(container)
  const kids = Array.from(container.children).filter(
    (c) => c !== dragged && !isAbsolute(c) && (c as HTMLElement).offsetParent !== null
  )
  const rects = kids.map((k) => k.getBoundingClientRect())
  let index = rects.findIndex((r) =>
    axis === 'x' ? p.x < r.left + r.width / 2 && p.y < r.bottom : p.y < r.top + r.height / 2
  )
  if (index < 0) index = kids.length
  const box = toRect(container.getBoundingClientRect())
  let line: Rect | null = null
  if (kids.length) {
    const prev = rects[index - 1]
    const next = rects[index]
    if (axis === 'x') {
      const x = prev && next && next.top < prev.bottom ? (prev.right + next.left) / 2 : next ? next.left - 3 : prev.right + 3
      const ref = next ?? prev
      line = { x: x - 1, y: ref.top, width: 2, height: ref.height }
    } else {
      const y = prev && next ? (prev.bottom + next.top) / 2 : next ? next.top - 3 : prev.bottom + 3
      const ref = next ?? prev
      line = { x: ref.left, y: y - 1, width: ref.width, height: 2 }
    }
  }
  return { container, before: kids[index] ?? null, line, box }
}

export function Canvas({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
  const drag = useRef<Drag | null>(null)
  const space = useRef(false)
  const [fx, setFx] = useState<Fx>(NO_FX)
  const [panning, setPanning] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)

  const doc = useCanvas((s) => s.doc)
  const selection = useCanvas((s) => s.selection)
  const hover = useCanvas((s) => s.hover)
  const tool = useCanvas((s) => s.tool)
  const view = useCanvas((s) => s.view)
  const editing = useCanvas((s) => s.editing)
  const presence = useCanvas((s) => s.presence)
  useCanvas((s) => s.version)

  // ---------- the frame ----------

  useEffect(() => {
    if (!iframe.current || !host.current) return
    const frame = new CanvasFrame(iframe.current)
    attachFrame(frame)
    const paint = (): void => {
      if (host.current)
        frame.setBackground(getComputedStyle(host.current).getPropertyValue('--canvas-bg').trim())
    }
    paint()
    const theme = new MutationObserver(paint)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const size = new ResizeObserver(() => useCanvas.getState().bump())
    size.observe(host.current)
    return () => {
      theme.disconnect()
      size.disconnect()
      attachFrame(null)
    }
  }, [])

  useEffect(() => {
    void useCanvas.getState().load(sessionId)
  }, [sessionId])

  const point = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = host.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }, [])

  // ---------- text ----------

  const startEdit = useCallback((ref: NodeRef) => {
    const frame = getFrame()
    const el = frame?.node(ref)
    if (!frame || !el || !isTextLeaf(el)) return
    const store = useCanvas.getState()
    el.contentEditable = 'true'
    el.spellcheck = false
    frame.iframe.style.pointerEvents = 'auto'
    store.select([ref])
    store.setEditing(ref)
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        el.blur()
      }
    }
    const onInput = (): void => useCanvas.getState().bump()
    const done = (): void => {
      el.removeEventListener('blur', done)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('input', onInput)
      el.removeAttribute('contenteditable')
      el.removeAttribute('spellcheck')
      frame.doc.getSelection()?.removeAllRanges()
      frame.iframe.style.pointerEvents = 'none'
      const state = useCanvas.getState()
      if (!el.textContent?.trim()) {
        el.remove()
        state.select([])
      }
      state.setEditing(null)
      state.commit()
    }
    el.addEventListener('blur', done)
    el.addEventListener('keydown', onKey)
    el.addEventListener('input', onInput)
    el.focus()
    frame.doc.getSelection()?.selectAllChildren(el)
  }, [])

  // ---------- images ----------

  const addImage = useCallback(async (file: File, at?: Point) => {
    const frame = getFrame()
    const store = useCanvas.getState()
    if (!frame || !store.sessionId || !file.type.startsWith('image/')) return
    const uploaded = await api.design.upload(store.sessionId, file, file.name)
    if (!uploaded.ok) return
    const size = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 })
      img.onerror = () => resolve({ w: 400, h: 300 })
      img.src = uploaded.data.url
    })
    const under = at ? frame.doc.elementFromPoint(at.x, at.y) : null
    // Dropped on a picture: swap it.
    if (under?.localName === 'img' && under.closest('.pl-root')) {
      under.setAttribute('src', uploaded.data.url)
      store.commit()
      return
    }
    let target = at ? frame.hit(at.x, at.y) : (store.selection[0] ?? null)
    if (!target) {
      const first = useCanvas.getState().doc.artboards[0]
      if (first && !at) target = { boardId: first.id, nodeId: null }
    }
    if (!target) {
      const w = Math.min(size.w, 1440)
      const world = at
        ? { x: (at.x - store.view.x) / store.view.zoom, y: (at.y - store.view.y) / store.view.zoom }
        : undefined
      const board = store.addBoard({
        name: file.name.replace(/\.[^.]+$/, ''),
        width: w,
        height: Math.round((size.h * w) / size.w),
        ...world
      })
      store.insertHtml(
        `<img src="${uploaded.data.url}" alt="" style="width: 100%; height: 100%; object-fit: cover; display: block">`,
        { boardId: board.id, nodeId: null }
      )
      return
    }
    const root = frame.root(target.boardId) as HTMLElement
    const zoom = store.view.zoom
    const w = Math.min(size.w, root.offsetWidth * 0.6)
    const h = (size.h * w) / size.w
    const r = root.getBoundingClientRect()
    const left = at ? (at.x - r.left) / zoom - w / 2 : (root.offsetWidth - w) / 2
    const top = at ? (at.y - r.top) / zoom - h / 2 : (root.offsetHeight - h) / 2
    store.insertHtml(
      `<img src="${uploaded.data.url}" alt="" style="position: absolute; left: ${round(left)}px; top: ${round(top)}px; width: ${round(w)}px; height: ${round(h)}px; object-fit: cover">`,
      { boardId: target.boardId, nodeId: null }
    )
  }, [])

  useEffect(() => {
    const onPick = (e: Event): void => {
      const files = (e as CustomEvent<File[]>).detail
      void (async () => {
        for (const file of files) await addImage(file)
      })()
    }
    window.addEventListener('polly:design-image', onPick)
    return () => window.removeEventListener('polly:design-image', onPick)
  }, [addImage])

  // ---------- pointer ----------

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const frame = getFrame()
    const store = useCanvas.getState()
    if (!frame || store.editing || renaming) return
    const p = point(e)
    const target = e.target as HTMLElement
    e.currentTarget.setPointerCapture(e.pointerId)
    ;(document.activeElement as HTMLElement | null)?.blur?.()

    if (e.button === 1 || store.tool === 'hand' || space.current) {
      drag.current = { kind: 'pan', start: p, view: { x: store.view.x, y: store.view.y } }
      setPanning(true)
      return
    }
    if (e.button !== 0) return

    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle
    const only = store.selection[0]
    if (handle && only && store.selection.length === 1) {
      if (handle.startsWith('rot') && only.nodeId !== null) {
        const el = frame.node(only) as HTMLElement
        const r = el.getBoundingClientRect()
        const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        const rotate = frame.view.getComputedStyle(el).rotate
        drag.current = {
          kind: 'rotate',
          ref: only,
          center,
          angle: Math.atan2(p.y - center.y, p.x - center.x),
          base: rotate && rotate !== 'none' ? parseFloat(rotate) || 0 : 0
        }
        return
      }
      if (!handle.startsWith('rot')) {
        beginResize(frame, only, handle as Handle, p)
        return
      }
    }

    const label = target.closest<HTMLElement>('[data-board-label]')?.dataset.boardLabel
    if (label) {
      const board = store.doc.artboards.find((b) => b.id === label)
      const rect = frame.rect({ boardId: label, nodeId: null })
      if (!board || !rect) return
      store.select([{ boardId: label, nodeId: null }])
      drag.current = {
        kind: 'board',
        start: p,
        id: label,
        x: board.x,
        y: board.y,
        rect,
        targets: store.doc.artboards
          .filter((b) => b.id !== label)
          .map((b) => frame.rect({ boardId: b.id, nodeId: null }))
          .filter((r): r is Rect => !!r)
      }
      return
    }

    if (store.tool === 'frame' || store.tool === 'rect' || store.tool === 'ellipse') {
      drag.current = { kind: 'draw', start: p, tool: store.tool }
      return
    }
    if (store.tool === 'text') {
      const hit = frame.hit(p.x, p.y)
      store.setTool('select')
      if (!hit) return
      const el = frame.node(hit)
      if (el && hit.nodeId && isTextLeaf(el)) {
        startEdit(hit)
        return
      }
      const root = frame.root(hit.boardId) as HTMLElement
      const r = root.getBoundingClientRect()
      const [ref] = store.insertHtml(
        `<div style="position: absolute; left: ${round((p.x - r.left) / store.view.zoom)}px; top: ${round((p.y - r.top) / store.view.zoom - 14)}px; font-size: 24px; line-height: 1.2; color: #111111; white-space: nowrap">Text</div>`,
        { boardId: hit.boardId, nodeId: null }
      )
      if (ref) requestAnimationFrame(() => startEdit(ref))
      return
    }

    const hit = frame.hit(p.x, p.y)
    const hitEl = hit ? frame.node(hit) : null
    const inside =
      !!hitEl &&
      store.selection.some((s) => s.nodeId !== null && frame.node(s)?.contains(hitEl) && s.boardId === hit?.boardId)
    if (!e.shiftKey && !inside) store.select(hit ? [hit] : [])
    drag.current = { kind: 'pending', start: p, hit, inside, shift: e.shiftKey, alt: e.altKey }
  }

  function beginResize(frame: CanvasFrame, ref: NodeRef, handle: Handle, p: Point): void {
    const store = useCanvas.getState()
    const rect = frame.rect(ref)
    if (!rect) return
    if (ref.nodeId === null) {
      const board = store.doc.artboards.find((b) => b.id === ref.boardId)
      if (!board) return
      drag.current = {
        kind: 'resize',
        start: p,
        handle,
        ref,
        w: board.width,
        h: board.height,
        left: board.x,
        top: board.y,
        absolute: true,
        own: 0,
        total: 0,
        rect,
        targets: store.doc.artboards
          .filter((b) => b.id !== board.id)
          .map((b) => frame.rect({ boardId: b.id, nodeId: null }))
          .filter((r): r is Rect => !!r)
      }
      return
    }
    const el = frame.node(ref) as HTMLElement
    const cs = frame.view.getComputedStyle(el)
    const absolute = isAbsolute(el)
    const parent = el.parentElement as HTMLElement
    drag.current = {
      kind: 'resize',
      start: p,
      handle,
      ref,
      w: el.offsetWidth ?? rect.width / store.view.zoom,
      h: el.offsetHeight ?? rect.height / store.view.zoom,
      left: cs.left === 'auto' ? el.offsetLeft : px(cs.left),
      top: cs.top === 'auto' ? el.offsetTop : px(cs.top),
      absolute,
      own: rotationOf(el),
      total: totalRotation(el),
      rect,
      targets: absolute ? siblingRects(parent, [el]) : []
    }
  }

  function siblingRects(parent: HTMLElement, moving: Element[]): Rect[] {
    const rects = Array.from(parent.children)
      .filter((c) => !moving.includes(c) && (c as HTMLElement).offsetParent !== null)
      .slice(0, 60)
      .map((c) => toRect(c.getBoundingClientRect()))
    rects.push(toRect(parent.getBoundingClientRect()))
    return rects
  }

  function marqueePick(frame: CanvasFrame, area: Rect): NodeRef[] {
    const found: NodeRef[] = []
    const walk = (el: Element, boardId: string): void => {
      for (const child of Array.from(el.children)) {
        const id = child.getAttribute('data-id')
        if (!id) continue
        const r = toRect(child.getBoundingClientRect())
        if (r.width === 0 && r.height === 0) continue
        if (contains(area, r)) found.push({ boardId, nodeId: id })
        else if (
          r.x < area.x + area.width &&
          r.x + r.width > area.x &&
          r.y < area.y + area.height &&
          r.y + r.height > area.y &&
          child.localName !== 'svg'
        )
          walk(child, boardId)
      }
    }
    for (const board of useCanvas.getState().doc.artboards) {
      const root = frame.root(board.id)
      if (root) walk(root, board.id)
    }
    return found
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const frame = getFrame()
    const store = useCanvas.getState()
    if (!frame) return
    const p = point(e)
    let d = drag.current
    const zoom = store.view.zoom

    if (!d) {
      if (store.tool === 'select' && !space.current && !store.editing) {
        const overHandle = (e.target as HTMLElement).closest('[data-handle], [data-board-label]')
        store.setHover(overHandle ? null : frame.hit(p.x, p.y))
      }
      return
    }

    if (d.kind === 'pending') {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < DRAG_START) return
      const nodes = store.selection
        .filter((r) => r.nodeId !== null)
        .map((ref) => ({ ref, el: frame.node(ref) as HTMLElement }))
        .filter((n) => n.el)
      const hitEl = d.hit ? frame.node(d.hit) : null
      const onBackdrop = !d.hit || d.hit.nodeId === null || (hitEl && isBackdrop(hitEl))
      if (d.shift || onBackdrop || nodes.length === 0) {
        d = drag.current = { kind: 'marquee', start: d.start, keep: d.shift ? store.selection : [] }
      } else if (nodes.every((n) => isAbsolute(n.el))) {
        if (d.alt) {
          // Alt-drag leaves a copy behind.
          for (const n of nodes) {
            const copy = cleanClone(n.el)
            stripIds(copy)
            n.el.before(copy)
          }
          frame.ensureIds(frame.root(nodes[0].ref.boardId) as HTMLElement)
        }
        const els = nodes.map((n) => n.el)
        d = drag.current = {
          kind: 'move',
          start: d.start,
          items: nodes.map(({ el }) => {
            const cs = frame.view.getComputedStyle(el)
            return {
              el,
              left: cs.left === 'auto' ? el.offsetLeft : px(cs.left),
              top: cs.top === 'auto' ? el.offsetTop : px(cs.top)
            }
          }),
          rect: union(els.map((el) => toRect(el.getBoundingClientRect()))),
          targets: siblingRects(els[0].parentElement as HTMLElement, els)
        }
      } else if (nodes.length === 1) {
        nodes[0].el.setAttribute('data-pl-ghost', '')
        d = drag.current = {
          kind: 'reorder',
          start: d.start,
          el: nodes[0].el,
          ref: nodes[0].ref,
          rect: toRect(nodes[0].el.getBoundingClientRect()),
          drop: null
        }
      } else {
        drag.current = null
        return
      }
      store.setHover(null)
    }

    const origin = 'start' in d ? d.start : p
    const dx = p.x - origin.x
    const dy = p.y - origin.y

    switch (d.kind) {
      case 'pan':
        store.setView({ zoom, x: d.view.x + dx, y: d.view.y + dy })
        break

      case 'marquee': {
        const area = rectOf(d.start, p)
        store.select([...d.keep, ...marqueePick(frame, area)])
        setFx({ ...NO_FX, marquee: area })
        break
      }

      case 'move': {
        const moved = { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
        const s = e.metaKey || e.ctrlKey ? { dx: 0, dy: 0, guides: [] } : snap(moved, d.targets, SNAP)
        for (const item of d.items) {
          item.el.style.left = `${round(item.left + (dx + s.dx) / zoom, 0.5)}px`
          item.el.style.top = `${round(item.top + (dy + s.dy) / zoom, 0.5)}px`
          item.el.style.right = 'auto'
          item.el.style.bottom = 'auto'
        }
        setFx({ ...NO_FX, guides: s.guides })
        store.bump()
        break
      }

      case 'reorder': {
        d.drop = dropTarget(frame, p, d.el)
        setFx({
          ...NO_FX,
          drop: d.drop,
          ghost: { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
        })
        break
      }

      case 'board': {
        const moved = { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
        const s = e.metaKey || e.ctrlKey ? { dx: 0, dy: 0, guides: [] } : snap(moved, d.targets, SNAP)
        store.updateBoard(
          d.id,
          { x: round(d.x + (dx + s.dx) / zoom), y: round(d.y + (dy + s.dy) / zoom) },
          false
        )
        setFx({ ...NO_FX, guides: s.guides })
        break
      }

      case 'resize': {
        const sx = d.handle.includes('e') ? 1 : d.handle.includes('w') ? -1 : 0
        const sy = d.handle.includes('s') ? 1 : d.handle.includes('n') ? -1 : 0
        let ddx = dx
        let ddy = dy
        let guides: Guide[] = []
        if (d.absolute && Math.abs(d.total) < 0.5 && !(e.metaKey || e.ctrlKey) && !e.shiftKey) {
          const moved = {
            x: d.rect.x + (sx < 0 ? dx : 0),
            y: d.rect.y + (sy < 0 ? dy : 0),
            width: d.rect.width + sx * dx,
            height: d.rect.height + sy * dy
          }
          const s = snap(moved, d.targets, SNAP, {
            x: sx > 0 ? ['max'] : sx < 0 ? ['min'] : [],
            y: sy > 0 ? ['max'] : sy < 0 ? ['min'] : []
          })
          ddx += s.dx
          ddy += s.dy
          guides = s.guides
        }
        const t = (d.total * Math.PI) / 180
        const lx = (ddx * Math.cos(t) + ddy * Math.sin(t)) / zoom
        const ly = (-ddx * Math.sin(t) + ddy * Math.cos(t)) / zoom
        const min = d.ref.nodeId === null ? 16 : 1
        let w = Math.max(min, d.w + sx * lx)
        let h = Math.max(min, d.h + sy * ly)
        if (e.shiftKey && sx && sy) {
          const ratio = d.w / d.h
          if (Math.abs(w / d.w - 1) > Math.abs(h / d.h - 1)) h = w / ratio
          else w = h * ratio
        }
        // Keep the opposite corner still, whatever the rotation.
        const r = (d.own * Math.PI) / 180
        const rot = (x: number, y: number): Point => ({
          x: x * Math.cos(r) - y * Math.sin(r),
          y: x * Math.sin(r) + y * Math.cos(r)
        })
        const a0 = rot((-sx * d.w) / 2, (-sy * d.h) / 2)
        const a1 = rot((-sx * w) / 2, (-sy * h) / 2)
        const cx = d.left + d.w / 2 + a0.x - a1.x
        const cy = d.top + d.h / 2 + a0.y - a1.y
        if (d.ref.nodeId === null) {
          store.updateBoard(
            d.ref.boardId,
            { x: round(cx - w / 2), y: round(cy - h / 2), width: round(w), height: round(h) },
            false
          )
        } else {
          const el = frame.node(d.ref) as HTMLElement
          if (d.absolute) {
            el.style.left = `${round(cx - w / 2, 0.5)}px`
            el.style.top = `${round(cy - h / 2, 0.5)}px`
            el.style.right = 'auto'
            el.style.bottom = 'auto'
          } else {
            el.style.flexShrink = '0'
          }
          if (sx || (e.shiftKey && sy)) el.style.width = `${round(w, 0.5)}px`
          if (sy || (e.shiftKey && sx)) el.style.height = `${round(h, 0.5)}px`
          store.bump()
        }
        setFx({ ...NO_FX, guides })
        break
      }

      case 'rotate': {
        const el = frame.node(d.ref) as HTMLElement
        const now = Math.atan2(p.y - d.center.y, p.x - d.center.x)
        let deg = d.base + ((now - d.angle) * 180) / Math.PI
        if (e.shiftKey) deg = round(deg, 15)
        deg = ((round(deg, 0.5) + 540) % 360) - 180
        el.style.rotate = `${deg}deg`
        store.bump()
        break
      }

      case 'draw':
        setFx({ ...NO_FX, marquee: rectOf(d.start, p) })
        break
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const frame = getFrame()
    const store = useCanvas.getState()
    const d = drag.current
    drag.current = null
    setPanning(false)
    setFx(NO_FX)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!frame || !d) return
    const p = point(e)
    const zoom = store.view.zoom

    switch (d.kind) {
      case 'pending':
        if (d.shift && d.hit) {
          const has = store.selection.some((s) => sameRef(s, d.hit))
          store.select(has ? store.selection.filter((s) => !sameRef(s, d.hit)) : [...store.selection, d.hit])
        } else if (d.inside && d.hit) {
          store.select([d.hit])
        }
        break

      case 'move': {
        // Dropped on another artboard: it moves there.
        const first = d.items[0]?.el
        const over = frame.hit(p.x, p.y)
        const from = store.selection[0]?.boardId
        if (first && over && from && over.boardId !== from) {
          const root = frame.root(over.boardId) as HTMLElement
          const rr = root.getBoundingClientRect()
          const refs: NodeRef[] = []
          for (const { el } of d.items) {
            const r = el.getBoundingClientRect()
            const cx = (r.left + r.width / 2 - rr.left) / zoom
            const cy = (r.top + r.height / 2 - rr.top) / zoom
            root.appendChild(el)
            el.style.left = `${round(cx - el.offsetWidth / 2)}px`
            el.style.top = `${round(cy - el.offsetHeight / 2)}px`
            refs.push({ boardId: over.boardId, nodeId: el.getAttribute('data-id') })
          }
          store.select(refs)
        }
        store.commit()
        break
      }

      case 'reorder': {
        d.el.removeAttribute('data-pl-ghost')
        const drop = d.drop
        if (drop && drop.before !== d.el && !d.el.contains(drop.container)) {
          drop.container.insertBefore(d.el, drop.before)
          const ref = frame.refOf(d.el)
          if (ref) store.select([ref])
        }
        store.commit()
        break
      }

      case 'board':
      case 'resize':
      case 'rotate':
        store.commit()
        break

      case 'draw': {
        const area = rectOf(d.start, p)
        const tiny = area.width < 4 && area.height < 4
        store.setTool('select')
        if (d.tool === 'frame') {
          store.addBoard({
            x: round((area.x - store.view.x) / zoom),
            y: round((area.y - store.view.y) / zoom),
            width: tiny ? 390 : Math.max(16, round(area.width / zoom)),
            height: tiny ? 844 : Math.max(16, round(area.height / zoom))
          })
          break
        }
        const hit = frame.hit(d.start.x, d.start.y)
        if (!hit) break
        const root = frame.root(hit.boardId) as HTMLElement
        const r = root.getBoundingClientRect()
        const w = tiny ? 120 : area.width / zoom
        const h = tiny ? 120 : area.height / zoom
        const left = (area.x - r.left) / zoom - (tiny ? 60 : 0)
        const top = (area.y - r.top) / zoom - (tiny ? 60 : 0)
        store.insertHtml(
          `<div style="position: absolute; left: ${round(left)}px; top: ${round(top)}px; width: ${round(w)}px; height: ${round(h)}px; background: #d9d9d9${d.tool === 'ellipse' ? '; border-radius: 9999px' : ''}"></div>`,
          { boardId: hit.boardId, nodeId: null }
        )
        break
      }
    }
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const frame = getFrame()
    if (!frame || useCanvas.getState().tool !== 'select') return
    const label = (e.target as HTMLElement).closest<HTMLElement>('[data-board-label]')?.dataset
      .boardLabel
    if (label) {
      setRenaming(label)
      return
    }
    const p = point(e)
    const hit = frame.hit(p.x, p.y)
    if (hit?.nodeId) startEdit(hit)
  }

  // ---------- wheel, keys, drops ----------

  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const store = useCanvas.getState()
      const p = point(e)
      if (e.ctrlKey || e.metaKey) store.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01))
      else store.setView({ ...store.view, x: store.view.x - e.deltaX, y: store.view.y - e.deltaY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [point])

  useEffect(() => {
    const typing = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement &&
      (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
    const onKeyDown = (e: KeyboardEvent): void => {
      if (typing(e.target)) return
      const s = useCanvas.getState()
      if (s.editing) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (e.code === 'Space') {
        space.current = true
        setPanning(true)
        e.preventDefault()
        return
      }
      const run = (fn: () => void): void => {
        e.preventDefault()
        fn()
      }
      if (mod && key === 'z') return run(() => (e.shiftKey ? s.redo() : s.undo()))
      if (mod && key === 'y') return run(s.redo)
      if (mod && key === 'd') return run(s.duplicate)
      if (mod && key === 'c') return run(s.copy)
      if (mod && key === 'x')
        return run(() => {
          s.copy()
          s.remove()
        })
      if (mod && key === 'v') return run(s.paste)
      if (mod && key === 'g') return run(() => (e.shiftKey ? s.ungroup() : s.group()))
      if (mod && key === 'a')
        return run(() => {
          const frame = getFrame()
          const board = s.selection[0]?.boardId ?? s.doc.artboards[0]?.id
          const root = board ? frame?.root(board) : null
          const inner = root?.children.length === 1 ? root.children[0] : root
          if (!board || !inner) return
          s.select(
            Array.from(inner.children)
              .map((c) => ({ boardId: board, nodeId: c.getAttribute('data-id') }))
              .filter((r) => r.nodeId)
          )
        })
      if (mod && key === '0') return run(() => s.zoomTo(1))
      if (mod && key === '1') return run(() => s.fit())
      if (mod && (key === '=' || key === '+')) return run(() => s.zoomTo(s.view.zoom * 1.25))
      if (mod && key === '-') return run(() => s.zoomTo(s.view.zoom / 1.25))
      if (mod) return
      if (key === 'backspace' || key === 'delete') return run(s.remove)
      if (key === 'escape') return run(() => (s.tool !== 'select' ? s.setTool('select') : s.selectParent()))
      if (key === 'enter') {
        const ref = s.selection[0]
        const el = ref && getFrame()?.node(ref)
        if (ref?.nodeId && el && isTextLeaf(el)) return run(() => startEdit(ref))
      }
      if (key === ']') return run(() => s.reorder(e.shiftKey ? 'front' : 'forward'))
      if (key === '[') return run(() => s.reorder(e.shiftKey ? 'back' : 'backward'))
      const step = e.shiftKey ? 10 : 1
      if (key === 'arrowleft') return run(() => s.nudge(-step, 0))
      if (key === 'arrowright') return run(() => s.nudge(step, 0))
      if (key === 'arrowup') return run(() => s.nudge(0, -step))
      if (key === 'arrowdown') return run(() => s.nudge(0, step))
      const tools: Record<string, Parameters<typeof s.setTool>[0]> = {
        v: 'select',
        h: 'hand',
        f: 'frame',
        r: 'rect',
        o: 'ellipse',
        t: 'text'
      }
      if (tools[key]) return run(() => s.setTool(tools[key]))
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        space.current = false
        if (drag.current?.kind !== 'pan') setPanning(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [startEdit])

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    const frame = getFrame()
    const types = Array.from(e.dataTransfer.types)
    if (!frame || !(types.includes(COMPONENT_MIME) || types.includes('Files'))) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (types.includes(COMPONENT_MIME)) setFx({ ...NO_FX, drop: dropTarget(frame, point(e), null) })
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const frame = getFrame()
    const store = useCanvas.getState()
    setFx(NO_FX)
    if (!frame) return
    e.preventDefault()
    const p = point(e)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      void (async () => {
        for (const file of files) await addImage(file, p)
      })()
      return
    }
    const html = e.dataTransfer.getData(COMPONENT_MIME)
    if (!html) return
    const drop = dropTarget(frame, p, null)
    if (!drop) {
      // Dropped on empty canvas: it gets a frame of its own.
      const board = store.addBoard({
        x: round((p.x - store.view.x) / store.view.zoom),
        y: round((p.y - store.view.y) / store.view.zoom),
        width: 480,
        height: 320
      })
      store.insertHtml(`<div class="flex h-full w-full items-center justify-center p-8">${html}</div>`, {
        boardId: board.id,
        nodeId: null
      })
      return
    }
    const ref = frame.refOf(drop.container)
    if (!ref) return
    const index = drop.before ? Array.from(drop.container.children).indexOf(drop.before) : undefined
    store.insertHtml(html, ref, index)
  }

  // ---------- drawing the overlay ----------

  const frame = getFrame()
  const zoom = view.zoom
  const busy = !!drag.current && drag.current.kind !== 'pending'

  const box = (ref: NodeRef): { cx: number; cy: number; w: number; h: number; deg: number } | null => {
    const r = frame?.rect(ref)
    if (!frame || !r) return null
    const flat = { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, deg: 0 }
    if (ref.nodeId === null) return flat
    const el = frame.node(ref) as HTMLElement | null
    if (!el || el.offsetWidth === undefined) return flat
    const deg = totalRotation(el)
    if (Math.abs(deg) < 0.01) return flat
    return { ...flat, w: el.offsetWidth * zoom, h: el.offsetHeight * zoom, deg }
  }

  const single = selection.length === 1 ? selection[0] : null
  const singleBox = single ? box(single) : null
  const singleEl = single?.nodeId ? frame?.node(single) : null
  const cursor = panning ? (drag.current?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair'

  return (
    <div
      ref={host}
      className={`dz-canvas${editing ? ' is-editing' : ''}`}
      style={{ cursor, '--dz-dot': `${clamp(20 * zoom, 10, 40)}px`, '--dz-dot-x': `${view.x}px`, '--dz-dot-y': `${view.y}px` } as React.CSSProperties}
    >
      <iframe ref={iframe} className="dz-frame" title="Design canvas" tabIndex={-1} />
      <div
        className="dz-overlay"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => !drag.current && useCanvas.getState().setHover(null)}
        onDoubleClick={onDoubleClick}
        onDragOver={onDragOver}
        onDragLeave={() => setFx(NO_FX)}
        onDrop={onDrop}
      >
        {doc.artboards.map((b) => {
          const r = frame?.rect({ boardId: b.id, nodeId: null })
          if (!r) return null
          const live = presence[b.id]
          const selected = selection.some((s) => s.boardId === b.id && s.nodeId === null)
          return (
            <div key={b.id}>
              <div
                className={`dz-board-label${selected ? ' is-selected' : ''}`}
                data-board-label={b.id}
                style={{
                  left: r.x,
                  top: r.y - 22,
                  maxWidth: Math.max(60, r.width),
                  color: live?.color
                }}
              >
                {renaming === b.id ? (
                  <input
                    autoFocus
                    defaultValue={b.name}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      useCanvas.getState().updateBoard(b.id, { name: e.target.value.trim() || b.name })
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                    }}
                  />
                ) : (
                  b.name
                )}
              </div>
              {live && <AgentPresence rect={r} presence={live} />}
            </div>
          )
        })}

        {hover && !busy && !selection.some((s) => sameRef(s, hover)) && hover.nodeId !== null && (
          <Outline box={box(hover)} className="dz-hover" />
        )}

        {selection.map((ref) =>
          single ? null : <Outline key={refKey(ref)} box={box(ref)} className="dz-selected" />
        )}

        {single && singleBox && !editing && (
          <div
            className={`dz-selection${single.nodeId === null ? ' is-board' : ''}`}
            style={{
              width: singleBox.w,
              height: singleBox.h,
              transform: `translate(${singleBox.cx - singleBox.w / 2}px, ${singleBox.cy - singleBox.h / 2}px) rotate(${singleBox.deg}deg)`
            }}
          >
            {!busy &&
              single.nodeId !== null &&
              ['nw', 'ne', 'se', 'sw'].map((c) => (
                <span key={c} className={`dz-rot is-${c}`} data-handle={`rot-${c}`} />
              ))}
            {!busy &&
              HANDLES.filter((h) => h.length === 2 || Math.min(singleBox.w, singleBox.h) > 24).map((h) => (
                <span key={h} className={`dz-handle is-${h}`} data-handle={h} />
              ))}
            <span className="dz-size" style={{ transform: `translateX(-50%) rotate(${-singleBox.deg}deg)` }}>
              {single.nodeId === null
                ? `${Math.round(singleBox.w / zoom)} × ${Math.round(singleBox.h / zoom)}`
                : `${Math.round((singleEl as HTMLElement | null)?.offsetWidth ?? singleBox.w / zoom)} × ${Math.round((singleEl as HTMLElement | null)?.offsetHeight ?? singleBox.h / zoom)}`}
            </span>
          </div>
        )}
        {single && singleBox && editing && <Outline box={singleBox} className="dz-editing" />}

        {fx.drop && (
          <>
            <div className="dz-drop-box" style={rectStyle(fx.drop.box)} />
            {fx.drop.line && <div className="dz-drop-line" style={rectStyle(fx.drop.line)} />}
          </>
        )}
        {fx.ghost && <div className="dz-ghost" style={rectStyle(fx.ghost)} />}
        {fx.marquee && <div className="dz-marquee" style={rectStyle(fx.marquee)} />}
        {fx.guides.map((g, i) => (
          <div
            key={i}
            className="dz-guide"
            style={
              g.axis === 'x'
                ? { left: g.pos, top: g.from, width: 1, height: g.to - g.from }
                : { top: g.pos, left: g.from, height: 1, width: g.to - g.from }
            }
          />
        ))}
      </div>
    </div>
  )
}

const rectStyle = (r: Rect): React.CSSProperties => ({
  left: r.x,
  top: r.y,
  width: r.width,
  height: r.height
})

function Outline({
  box,
  className
}: {
  box: { cx: number; cy: number; w: number; h: number; deg: number } | null
  className: string
}): React.JSX.Element | null {
  if (!box) return null
  return (
    <div
      className={`dz-outline ${className}`}
      style={{
        width: box.w,
        height: box.h,
        transform: `translate(${box.cx - box.w / 2}px, ${box.cy - box.h / 2}px) rotate(${box.deg}deg)`
      }}
    />
  )
}
