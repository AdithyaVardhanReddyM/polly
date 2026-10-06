import { create } from 'zustand'
import type { CoderEvent } from '../../../shared/contracts'
import { api } from '../api'
import { frameNames } from '../coder/toolMeta'
import { capture } from './exporters'
import { boxOf, CanvasFrame, cleanClone, isAbsolute, isContainer } from './frame'
import {
  AGENT_COLORS,
  CANVAS_ID,
  clamp,
  isLoose,
  newId,
  refKey,
  sameRef,
  type Artboard,
  type DesignDoc,
  type NodeRef,
  type Tool,
  type View
} from './model'

/**
 * The canvas: the design document, what is selected, the view, and undo.
 *
 * The live DOM inside the frame is the truth while the user works; `commit`
 * reads it back into the document, records an undo step and saves. Anything
 * that changes the DOM bumps `version` so the overlay and panels re-read it.
 */

const GAP = 120
const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
const HISTORY = 100
const SAVE_RETRY = 4000
const SAVE_TRIES = 5

export interface Presence {
  label: string
  color: string
  /** Where the agent's cursor is, as a fraction of the artboard. */
  x: number
  y: number
  /** Still an empty frame the agent has not filled yet. */
  building: boolean
}

interface Snapshot {
  artboards: Artboard[]
  fonts: string[]
}

interface CanvasState {
  sessionId: string | null
  loaded: boolean
  doc: DesignDoc
  selection: NodeRef[]
  hover: NodeRef | null
  tool: Tool
  view: View
  version: number
  editing: NodeRef | null
  canUndo: boolean
  canRedo: boolean
  saveState: 'saved' | 'saving' | 'error'
  presence: Record<string, Presence>
  /** Canvas pixels covered by the floating panels, kept clear when fitting. */
  insets: { left: number; right: number }

  load: (sessionId: string | null) => Promise<void>
  /** The design's session, made now if it has none yet (uploads need one). */
  ensureSession: () => Promise<string | null>
  flush: () => Promise<void>
  bump: () => void
  commit: () => void
  undo: () => void
  redo: () => void

  setTool: (tool: Tool) => void
  setHover: (ref: NodeRef | null) => void
  select: (refs: NodeRef[]) => void
  setEditing: (ref: NodeRef | null) => void
  setView: (view: View) => void
  setInsets: (insets: { left: number; right: number }) => void
  zoomAt: (x: number, y: number, factor: number) => void
  zoomTo: (zoom: number) => void
  fit: (boardId?: string) => void

  addBoard: (board: Partial<Artboard>) => Artboard
  /** The board that holds layers drawn outside any frame, made on first use. */
  looseLayer: () => NodeRef
  updateBoard: (id: string, patch: Partial<Artboard>, commit?: boolean) => void
  setStyle: (props: Record<string, string | null>, commit?: boolean) => void
  setFonts: (fonts: string[]) => void
  useFont: (family: string) => void
  insertHtml: (html: string, container: NodeRef, index?: number) => NodeRef[]
  remove: () => void
  duplicate: () => void
  copy: () => void
  paste: () => void
  group: () => void
  ungroup: () => void
  reorder: (direction: 'forward' | 'backward' | 'front' | 'back') => void
  nudge: (dx: number, dy: number) => void
  selectParent: () => void

  onAgentEvent: (event: CoderEvent, sessionId: string) => void
}

let frame: CanvasFrame | null = null
let last: Snapshot = { artboards: [], fonts: [] }
let past: Snapshot[] = []
let future: Snapshot[] = []
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
let dirty = false
let failedSaves = 0
let clipboard: { html: string; absolute: boolean }[] = []
const presenceTimers = new Map<string, ReturnType<typeof setTimeout>>()
interface SessionMaker {
  /** Make a session for the design and return its id. */
  create: () => Promise<string | null>
  /** Show it as the open design, once the canvas has saved into it. */
  open: (id: string) => void
}
let maker: SessionMaker | null = null
let adopting: Promise<void> | null = null

export const getFrame = (): CanvasFrame | null => frame

/**
 * How a canvas without a session gets one: the first hand edit on a new design
 * calls this, and the canvas then saves into the session it returns.
 */
export function setSessionMaker(next: SessionMaker | null): void {
  maker = next
}

const emptyDoc = (): DesignDoc => ({ rev: 0, artboards: [], fonts: [], selection: [] })
const snap = (doc: DesignDoc): Snapshot => ({
  artboards: doc.artboards.map((b) => ({ ...b })),
  fonts: [...doc.fonts]
})
const same = (a: Snapshot, b: Snapshot): boolean => JSON.stringify(a) === JSON.stringify(b)
const px = (v: string): number => parseFloat(v) || 0

function stripIds(el: Element): void {
  el.removeAttribute('data-id')
  el.querySelectorAll('[data-id]').forEach((n) => n.removeAttribute('data-id'))
}

export const useCanvas = create<CanvasState>((set, get) => {
  function scheduleSave(): void {
    dirty = true
    if (saveTimer) clearTimeout(saveTimer)
    if (!get().sessionId) {
      void adoptSession()
      return
    }
    saveTimer = setTimeout(() => void get().flush(), 600)
  }

  /** A new design drawn by hand: make its session, then save what is there. */
  function adoptSession(): Promise<void> {
    if (adopting) return adopting
    if (!maker) return Promise.resolve()
    const { create, open } = maker
    adopting = (async () => {
      const id = await create()
      if (!id || get().sessionId) return
      // The canvas takes the session before the page hears of it, so opening it
      // does not reload an empty document over what was drawn.
      set({ sessionId: id, loaded: true })
      await get().flush()
      open(id)
    })().finally(() => {
      adopting = null
    })
    return adopting
  }

  /** Where everything is, in canvas coordinates: frames, and the loose layers' own boxes. */
  function bounds(boardId?: string): { left: number; top: number; right: number; bottom: number } | null {
    const boxes: { left: number; top: number; right: number; bottom: number }[] = []
    for (const b of get().doc.artboards) {
      if (boardId && b.id !== boardId) continue
      if (!isLoose(b.id)) {
        boxes.push({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height })
        continue
      }
      const root = frame?.root(b.id)
      for (const child of Array.from(root?.children ?? [])) {
        const box = boxOf(child)
        if (!box.width && !box.height) continue
        boxes.push({ left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height })
      }
    }
    if (boxes.length === 0) return null
    return {
      left: Math.min(...boxes.map((b) => b.left)),
      top: Math.min(...boxes.map((b) => b.top)),
      right: Math.max(...boxes.map((b) => b.right)),
      bottom: Math.max(...boxes.map((b) => b.bottom))
    }
  }

  /** Read the DOM back into the document. */
  function readDom(): DesignDoc {
    const doc = get().doc
    if (!frame) return doc
    const f = frame
    return { ...doc, artboards: doc.artboards.map((b) => ({ ...b, html: f.serialize(b.id) })) }
  }

  function remount(doc: DesignDoc): void {
    frame?.mount(doc.artboards)
    frame?.setFonts(doc.fonts)
  }

  /** Drop references to nodes that no longer exist. */
  function prune(refs: NodeRef[]): NodeRef[] {
    return refs.filter((r) => frame?.node(r))
  }

  function restore(snapshot: Snapshot): void {
    const doc = { ...get().doc, artboards: snapshot.artboards, fonts: snapshot.fonts }
    remount(doc)
    set((s) => ({
      doc,
      selection: prune(s.selection),
      hover: null,
      version: s.version + 1,
      canUndo: past.length > 0,
      canRedo: future.length > 0
    }))
    scheduleSave()
  }

  function selectedElements(): { ref: NodeRef; el: HTMLElement }[] {
    return get()
      .selection.filter((r) => r.nodeId !== null)
      .map((ref) => ({ ref, el: frame?.node(ref) as HTMLElement }))
      .filter((n) => n.el)
  }

  function setPresence(boardId: string, patch: Partial<Presence> | null, ttl?: number): void {
    const timer = presenceTimers.get(boardId)
    if (timer) clearTimeout(timer)
    presenceTimers.delete(boardId)
    set((s) => {
      const next = { ...s.presence }
      if (patch === null) {
        delete next[boardId]
      } else {
        const index = s.doc.artboards.findIndex((b) => b.id === boardId)
        const fresh: Presence = {
          label: 'Finding the vibe',
          color: AGENT_COLORS[Math.max(0, index) % AGENT_COLORS.length],
          x: 0.4,
          y: 0.55,
          building: false
        }
        next[boardId] = { ...fresh, ...next[boardId], ...patch }
      }
      return { presence: next }
    })
    if (patch && ttl) presenceTimers.set(boardId, setTimeout(() => setPresence(boardId, null), ttl))
  }

  return {
    sessionId: null,
    loaded: false,
    doc: emptyDoc(),
    selection: [],
    hover: null,
    tool: 'select',
    view: { x: 0, y: 0, zoom: 1 },
    version: 0,
    editing: null,
    canUndo: false,
    canRedo: false,
    saveState: 'saved',
    presence: {},
    insets: { left: 0, right: 0 },

    async load(sessionId) {
      if (sessionId && sessionId === get().sessionId && get().loaded) {
        // Already ours: a design that just got its session, or the page coming back
        // with a fresh frame that needs the document put into it again.
        if (frame && frame.world.children.length === 0 && get().doc.artboards.length) {
          await frame.ready
          remount(get().doc)
          set((s) => ({ version: s.version + 1 }))
          get().fit()
        }
        return
      }
      if (saveTimer) clearTimeout(saveTimer)
      await get().flush()
      past = []
      future = []
      dirty = false
      failedSaves = 0
      set({
        sessionId,
        loaded: false,
        doc: emptyDoc(),
        selection: [],
        hover: null,
        editing: null,
        presence: {},
        canUndo: false,
        canRedo: false,
        saveState: 'saved'
      })
      frame?.mount([])
      if (!sessionId) return
      const res = await api.design.get(sessionId)
      if (get().sessionId !== sessionId) return
      // A run that is already drawing may have got here first; keep the newer one.
      const doc = res.ok && res.data.rev >= get().doc.rev ? res.data : get().doc
      await frame?.ready
      remount(doc)
      last = snap(doc)
      set((s) => ({ doc, loaded: true, version: s.version + 1 }))
      get().fit()
    },

    async ensureSession() {
      if (!get().sessionId) await adoptSession()
      return get().sessionId
    },

    async flush() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      const { sessionId, loaded } = get()
      if (!sessionId || !loaded) return
      saving = saving.then(async () => {
        if (get().sessionId !== sessionId) return
        dirty = false
        set({ saveState: 'saving' })
        const body = (): DesignDoc => ({
          ...get().doc,
          selection: get().selection.map((r) => ({ artboard_id: r.boardId, node_id: r.nodeId }))
        })
        let res = await api.design.put(sessionId, body())
        if (!res.ok && res.error.includes('changed on the server')) {
          // The agent wrote in between; its edits reached us as events, so ours win.
          const current = await api.design.get(sessionId)
          if (current.ok) {
            set((s) => ({ doc: { ...s.doc, rev: current.data.rev } }))
            res = await api.design.put(sessionId, body())
          }
        }
        if (get().sessionId !== sessionId) return
        if (res.ok) {
          failedSaves = 0
          set((s) => ({ doc: { ...s.doc, rev: res.data.rev }, saveState: 'saved' }))
        } else {
          // Try again shortly (the server may have been restarting); the next edit tries too.
          dirty = true
          set({ saveState: 'error' })
          if (++failedSaves < SAVE_TRIES) {
            if (saveTimer) clearTimeout(saveTimer)
            saveTimer = setTimeout(() => void get().flush(), SAVE_RETRY)
          }
        }
      })
      await saving
    },

    bump() {
      set((s) => ({ version: s.version + 1 }))
    },

    commit() {
      let doc = readDom()
      // The loose layer goes once its last layer does.
      const layer = doc.artboards.find((b) => isLoose(b.id))
      if (layer && !layer.html.trim()) {
        doc = { ...doc, artboards: doc.artboards.filter((b) => b !== layer) }
        remount(doc)
      }
      const now = snap(doc)
      if (same(now, last)) {
        set((s) => ({ doc, version: s.version + 1 }))
        if (dirty) scheduleSave()
        return
      }
      past.push(last)
      if (past.length > HISTORY) past.shift()
      future = []
      last = now
      set((s) => ({ doc, version: s.version + 1, canUndo: true, canRedo: false }))
      scheduleSave()
    },

    undo() {
      const previous = past.pop()
      if (!previous) return
      future.push(last)
      last = previous
      restore(previous)
    },

    redo() {
      const next = future.pop()
      if (!next) return
      past.push(last)
      last = next
      restore(next)
    },

    setTool(tool) {
      set({ tool })
    },

    setHover(ref) {
      if (!sameRef(ref, get().hover) && (ref || get().hover)) set({ hover: ref })
    },

    select(refs) {
      const seen = new Set<string>()
      const unique = refs.filter(
        (r) => !(isLoose(r.boardId) && r.nodeId === null) && !seen.has(refKey(r)) && seen.add(refKey(r))
      )
      set({ selection: unique })
    },

    setEditing(ref) {
      set({ editing: ref })
    },

    setView(view) {
      frame?.setView(view)
      set({ view })
    },

    setInsets(insets) {
      const now = get().insets
      if (now.left !== insets.left || now.right !== insets.right) set({ insets })
    },

    zoomAt(x, y, factor) {
      const { view } = get()
      const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const k = zoom / view.zoom
      get().setView({ zoom, x: x - (x - view.x) * k, y: y - (y - view.y) * k })
    },

    zoomTo(zoom) {
      const el = frame?.iframe
      if (!el) return
      get().zoomAt(el.clientWidth / 2, el.clientHeight / 2, zoom / get().view.zoom)
    },

    fit(boardId) {
      const el = frame?.iframe
      if (!el) return
      // Fit into the part of the canvas the floating panels leave clear.
      const { left: inLeft, right: inRight } = get().insets
      const width = Math.max(200, el.clientWidth - inLeft - inRight)
      const box = bounds(boardId)
      if (!box) {
        get().setView({ x: inLeft + width / 2, y: el.clientHeight / 2, zoom: 1 })
        return
      }
      const w = Math.max(1, box.right - box.left)
      const h = Math.max(1, box.bottom - box.top)
      const pad = 64
      const zoom = clamp(
        Math.min((width - pad * 2) / w, (el.clientHeight - pad * 2 - 40) / h),
        MIN_ZOOM,
        1
      )
      get().setView({
        zoom,
        x: inLeft + (width - w * zoom) / 2 - box.left * zoom,
        // A little high of centre: the toolbar sits along the bottom.
        y: (el.clientHeight - 40 - h * zoom) / 2 - box.top * zoom + 6
      })
    },

    addBoard(partial) {
      const current = readDom()
      const frames = current.artboards.filter((b) => !isLoose(b.id))
      const width = partial.width ?? 390
      const right = frames.length ? Math.max(...frames.map((b) => b.x + b.width)) : 0
      const top = frames.length ? Math.min(...frames.map((b) => b.y)) : 0
      const board: Artboard = {
        id: newId('a'),
        name: partial.name ?? `Frame ${frames.length + 1}`,
        x: partial.x ?? (frames.length ? right + GAP : 0),
        y: partial.y ?? top,
        width,
        height: partial.height ?? 844,
        background: partial.background ?? '#ffffff',
        html: partial.html ?? ''
      }
      // New frames go under the loose layers, which stay on top of everything.
      const loose = current.artboards.filter((b) => isLoose(b.id))
      const next = { ...current, artboards: [...frames, board, ...loose] }
      remount(next)
      set({ doc: next, selection: [{ boardId: board.id, nodeId: null }] })
      get().commit()
      return board
    },

    looseLayer() {
      const ref = { boardId: CANVAS_ID, nodeId: null }
      if (get().doc.artboards.some((b) => isLoose(b.id))) return ref
      const layer: Artboard = {
        id: CANVAS_ID,
        name: 'Canvas',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        background: 'transparent',
        html: ''
      }
      const current = readDom()
      const next = { ...current, artboards: [...current.artboards, layer] }
      remount(next)
      set({ doc: next })
      return ref
    },

    updateBoard(id, patch, commit = true) {
      const doc = { ...get().doc }
      doc.artboards = doc.artboards.map((b) => (b.id === id ? { ...b, ...patch } : b))
      // Position, size and background only: the content is left alone.
      const board = doc.artboards.find((b) => b.id === id)
      const el = frame?.board(id)
      if (board && el) {
        el.style.left = `${board.x}px`
        el.style.top = `${board.y}px`
        el.style.width = `${board.width}px`
        el.style.height = `${board.height}px`
        ;(el.firstElementChild as HTMLElement).style.background = board.background
      }
      set((s) => ({ doc, version: s.version + 1 }))
      if (commit) get().commit()
    },

    setStyle(props, commit = true) {
      for (const { el } of selectedElements()) {
        for (const [name, value] of Object.entries(props)) {
          if (value === null || value === '') el.style.removeProperty(name)
          else el.style.setProperty(name, value)
        }
      }
      if (commit) get().commit()
      else get().bump()
    },

    setFonts(fonts) {
      frame?.setFonts(fonts)
      set((s) => ({ doc: { ...s.doc, fonts } }))
      get().commit()
    },

    useFont(family) {
      const { doc } = get()
      if (!doc.fonts.includes(family)) {
        frame?.setFonts([...doc.fonts, family])
        set((s) => ({ doc: { ...s.doc, fonts: [...s.doc.fonts, family] } }))
      }
    },

    insertHtml(html, container, index) {
      const parent = frame?.node(container)
      if (!frame || !parent) return []
      const holder = frame.doc.createElement('div')
      holder.innerHTML = html
      const nodes = Array.from(holder.children)
      nodes.forEach(stripIds)
      const before = index === undefined ? null : (parent.children[index] ?? null)
      for (const node of nodes) parent.insertBefore(node, before)
      frame.ensureIds(frame.root(container.boardId) as HTMLElement)
      const refs = nodes.map((n) => ({
        boardId: container.boardId,
        nodeId: n.getAttribute('data-id')
      }))
      set({ selection: refs })
      get().commit()
      return refs
    },

    remove() {
      const { selection, doc } = get()
      if (selection.length === 0) return
      const boards = new Set(selection.filter((r) => r.nodeId === null).map((r) => r.boardId))
      for (const { el } of selectedElements()) el.remove()
      if (boards.size) {
        const next = { ...readDom(), artboards: doc.artboards.filter((b) => !boards.has(b.id)) }
        remount(next)
        set({ doc: next })
      }
      set({ selection: [], hover: null })
      get().commit()
    },

    duplicate() {
      const { selection, doc } = get()
      const refs: NodeRef[] = []
      for (const ref of selection) {
        if (ref.nodeId === null) {
          const board = doc.artboards.find((b) => b.id === ref.boardId)
          if (!board || !frame) continue
          const copy = get().addBoard({
            name: `${board.name} copy`,
            width: board.width,
            height: board.height,
            background: board.background,
            html: frame.serialize(board.id).replace(/ data-id="[^"]*"/g, '')
          })
          refs.push({ boardId: copy.id, nodeId: null })
          continue
        }
        const el = frame?.node(ref)
        if (!el || !frame) continue
        const clone = cleanClone(el)
        stripIds(clone)
        if (isAbsolute(el)) {
          const cs = frame.view.getComputedStyle(el)
          clone.style.left = `${px(cs.left) + 16}px`
          clone.style.top = `${px(cs.top) + 16}px`
          clone.style.right = 'auto'
          clone.style.bottom = 'auto'
        }
        el.after(clone)
        frame.ensureIds(frame.root(ref.boardId) as HTMLElement)
        refs.push({ boardId: ref.boardId, nodeId: clone.getAttribute('data-id') })
      }
      if (refs.length) set({ selection: refs })
      get().commit()
    },

    copy() {
      clipboard = selectedElements().map(({ el }) => ({
        html: cleanClone(el).outerHTML,
        absolute: isAbsolute(el)
      }))
    },

    paste() {
      if (!frame || clipboard.length === 0) return
      const { selection, doc } = get()
      const firstFrame = doc.artboards.find((b) => !isLoose(b.id))
      const target =
        selection[0] ?? (firstFrame ? { boardId: firstFrame.id, nodeId: null } : get().looseLayer())
      const anchor = frame.node(target)
      if (!anchor) return
      // Into a selected container or artboard; otherwise next to the selected node.
      const inside = target.nodeId === null || (isContainer(anchor) && anchor.children.length === 0)
      const parent = inside ? anchor : (anchor.parentElement as HTMLElement)
      const refs: NodeRef[] = []
      let after: Element | null = inside ? null : anchor
      for (const item of clipboard) {
        const holder = frame.doc.createElement('div')
        holder.innerHTML = item.html
        const node = holder.firstElementChild as HTMLElement | null
        if (!node) continue
        stripIds(node)
        if (item.absolute) {
          node.style.left = `${px(node.style.left) + 16}px`
          node.style.top = `${px(node.style.top) + 16}px`
        } else if (isLoose(target.boardId)) {
          // Out of its layout and onto the open canvas: place it where the user is looking.
          const { view } = get()
          const el = frame.iframe
          node.style.position = 'absolute'
          node.style.left = `${Math.round((el.clientWidth / 2 - view.x) / view.zoom)}px`
          node.style.top = `${Math.round((el.clientHeight / 2 - view.y) / view.zoom)}px`
        }
        if (after) after.after(node)
        else parent.appendChild(node)
        after = node
        frame.ensureIds(frame.root(target.boardId) as HTMLElement)
        refs.push({ boardId: target.boardId, nodeId: node.getAttribute('data-id') })
      }
      set({ selection: refs })
      get().commit()
    },

    group() {
      const nodes = selectedElements()
      if (!frame || nodes.length === 0) return
      const parent = nodes[0].el.parentElement
      if (!parent || nodes.some((n) => n.el.parentElement !== parent)) return
      const ordered = Array.from(parent.children).filter((c) => nodes.some((n) => n.el === c))
      const wrapper = frame.doc.createElement('div')
      wrapper.setAttribute('data-name', 'Group')
      if (ordered.every(isAbsolute)) {
        const boxes = ordered.map((el) => {
          const h = el as HTMLElement
          const box = boxOf(h)
          return { el: h, l: box.left, t: box.top, w: box.width, h: box.height }
        })
        const l = Math.min(...boxes.map((b) => b.l))
        const t = Math.min(...boxes.map((b) => b.t))
        const r = Math.max(...boxes.map((b) => b.l + b.w))
        const b = Math.max(...boxes.map((b) => b.t + b.h))
        wrapper.style.cssText = `position: absolute; left: ${l}px; top: ${t}px; width: ${r - l}px; height: ${b - t}px`
        parent.insertBefore(wrapper, ordered[0])
        for (const box of boxes) {
          box.el.style.left = `${box.l - l}px`
          box.el.style.top = `${box.t - t}px`
          box.el.style.right = 'auto'
          box.el.style.bottom = 'auto'
          wrapper.appendChild(box.el)
        }
      } else {
        const cs = frame.view.getComputedStyle(parent)
        const row = cs.display.includes('flex') && cs.flexDirection.startsWith('row')
        const gap = cs.display.includes('flex') ? cs.gap : '8px'
        wrapper.style.cssText = `display: flex; flex-direction: ${row ? 'row' : 'column'}; gap: ${gap === 'normal' ? '8px' : gap}`
        parent.insertBefore(wrapper, ordered[0])
        for (const el of ordered) wrapper.appendChild(el)
      }
      const boardId = nodes[0].ref.boardId
      frame.ensureIds(frame.root(boardId) as HTMLElement)
      set({ selection: [{ boardId, nodeId: wrapper.getAttribute('data-id') }] })
      get().commit()
    },

    ungroup() {
      const nodes = selectedElements()
      if (!frame || nodes.length !== 1) return
      const { el, ref } = nodes[0]
      if (!isContainer(el) || el.children.length === 0 || !el.parentElement) return
      const absolute = isAbsolute(el)
      const children = Array.from(el.children) as HTMLElement[]
      for (const child of children) {
        if (absolute && isAbsolute(child)) {
          child.style.left = `${boxOf(child).left + boxOf(el).left}px`
          child.style.top = `${boxOf(child).top + boxOf(el).top}px`
        }
        el.before(child)
      }
      el.remove()
      set({
        selection: children.map((c) => ({ boardId: ref.boardId, nodeId: c.getAttribute('data-id') }))
      })
      get().commit()
    },

    reorder(direction) {
      for (const { el } of selectedElements()) {
        const parent = el.parentElement
        if (!parent) continue
        if (direction === 'forward') el.nextElementSibling?.after(el)
        else if (direction === 'backward') el.previousElementSibling?.before(el)
        else if (direction === 'front') parent.appendChild(el)
        else parent.insertBefore(el, parent.firstElementChild)
      }
      get().commit()
    },

    nudge(dx, dy) {
      const { selection, doc } = get()
      let moved = false
      for (const ref of selection) {
        if (ref.nodeId === null) {
          const board = doc.artboards.find((b) => b.id === ref.boardId)
          if (board) get().updateBoard(board.id, { x: board.x + dx, y: board.y + dy }, false)
          moved = true
          continue
        }
        const el = frame?.node(ref)
        if (!el || !frame || !isAbsolute(el)) continue
        const cs = frame.view.getComputedStyle(el)
        el.style.left = `${px(cs.left) + dx}px`
        el.style.top = `${px(cs.top) + dy}px`
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        moved = true
      }
      if (moved) get().commit()
    },

    selectParent() {
      const { selection } = get()
      if (selection.length === 0) return
      const ref = selection[0]
      if (ref.nodeId === null) {
        set({ selection: [] })
        return
      }
      const parent = frame?.node(ref)?.parentElement ?? null
      const up = frame?.refOf(parent)
      set({ selection: up && !(isLoose(up.boardId) && up.nodeId === null) ? [up] : [] })
    },

    onAgentEvent(event, sessionId) {
      if (sessionId !== get().sessionId) return
      switch (event.type) {
        case 'tool.streaming': {
          const id = event.artboard_id
          if (!id || !get().doc.artboards.some((b) => b.id === id)) break
          const labels: Record<string, string> = {
            write_html: 'Designing',
            update_nodes: 'Refining',
            delete_nodes: 'Tidying up',
            update_artboard: 'Resizing',
            review_design: 'Taking a look'
          }
          setPresence(id, { label: labels[event.name] ?? 'Working' })
          break
        }
        case 'design.artboard': {
          if (event.rev <= get().doc.rev) break
          const board = event.artboard
          const before = readDom()
          const exists = before.artboards.some((b) => b.id === board.id)
          // A new frame goes under the loose layers, which stay on top.
          const loose = before.artboards.filter((b) => isLoose(b.id))
          const doc = {
            ...before,
            rev: event.rev,
            artboards: exists
              ? before.artboards.map((b) => (b.id === board.id ? board : b))
              : [...before.artboards.filter((b) => !isLoose(b.id)), board, ...loose]
          }
          remount(doc)
          past.push(last)
          future = []
          last = snap(doc)
          set((s) => ({
            doc,
            selection: prune(s.selection),
            version: s.version + 1,
            canUndo: true,
            canRedo: false
          }))
          if (event.action === 'create') {
            setPresence(board.id, { building: true, label: 'Finding the vibe' })
            get().fit()
          } else if (event.action === 'write') {
            frame?.root(board.id)?.firstElementChild?.classList.add('pl-reveal')
            setPresence(board.id, { building: false, label: 'Done' }, 900)
          } else {
            flash(board, event.focus, (x, y) =>
              setPresence(board.id, { building: false, label: 'Edited', x, y }, 1600)
            )
          }
          break
        }
        case 'design.removed': {
          if (event.rev <= get().doc.rev) break
          const before = readDom()
          const doc = {
            ...before,
            rev: event.rev,
            artboards: before.artboards.filter((b) => b.id !== event.artboard_id)
          }
          remount(doc)
          last = snap(doc)
          set((s) => ({ doc, selection: prune(s.selection), version: s.version + 1 }))
          setPresence(event.artboard_id, null)
          break
        }
        case 'design.fonts':
          frame?.setFonts(event.fonts)
          set((s) => ({ doc: { ...s.doc, fonts: event.fonts, rev: Math.max(s.doc.rev, event.rev) } }))
          break
        case 'design.screenshot': {
          setPresence(event.artboard_id, { label: 'Taking a look', building: false }, 4000)
          const f = frame
          const root = f?.root(event.artboard_id)
          if (!f || !root) break
          void capture(root, 'png', 1568)
            .then((url) => api.design.screenshot(sessionId, event.request_id, url))
            .catch(() => undefined)
          break
        }
        case 'run.finished':
          for (const id of Object.keys(get().presence)) setPresence(id, null)
          break
      }
    }
  }

  /** Point at what the agent just changed: a ring on the nodes, the cursor over them. */
  function flash(board: Artboard, focus: string[], moveTo: (x: number, y: number) => void): void {
    const root = frame?.root(board.id)
    if (!root) return
    const color = get().presence[board.id]?.color
    const nodes = focus
      .map((id) => root.querySelector<HTMLElement>(`[data-id="${id}"]`))
      .filter((n): n is HTMLElement => !!n)
    for (const node of nodes.slice(0, 6)) {
      if (color) node.style.setProperty('--pl-flash', color)
      node.classList.add('pl-flash')
      setTimeout(() => {
        node.classList.remove('pl-flash')
        node.style.removeProperty('--pl-flash')
        if (node.getAttribute('style') === '') node.removeAttribute('style')
      }, 950)
    }
    const first = nodes[0]
    if (!first) {
      moveTo(0.5, 0.5)
      return
    }
    const a = first.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    moveTo(
      clamp((a.left + a.width / 2 - b.left) / b.width, 0.04, 0.96),
      clamp((a.top + a.height / 2 - b.top) / b.height, 0.04, 0.96)
    )
  }
})

// Steps in the chat name frames, not ids.
useCanvas.subscribe((state, prev) => {
  if (state.doc.artboards === prev.doc.artboards) return
  frameNames.clear()
  for (const b of state.doc.artboards) frameNames.set(b.id, b.name)
})

export function attachFrame(next: CanvasFrame | null): void {
  frame = next
  if (next) next.setView(useCanvas.getState().view)
}
