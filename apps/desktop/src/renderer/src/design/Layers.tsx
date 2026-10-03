import {
  ChevronRight,
  Circle,
  Component,
  Eye,
  EyeOff,
  Frame,
  Image,
  LayoutGrid,
  Shapes,
  Square,
  Type
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { COMPONENT_MIME } from './Canvas'
import { PALETTE } from './components'
import { isContainer, isTextLeaf } from './frame'
import { refKey, type NodeRef } from './model'
import { getFrame, useCanvas } from './store'

/** The left panel: the layer tree of every frame, and the component palette. */
export function LeftPanel(): React.JSX.Element {
  const [tab, setTab] = useState<'layers' | 'components'>('layers')
  return (
    <aside className="dz-left">
      <div className="dz-tabs">
        <button className={tab === 'layers' ? 'is-active' : ''} onClick={() => setTab('layers')}>
          Layers
        </button>
        <button className={tab === 'components' ? 'is-active' : ''} onClick={() => setTab('components')}>
          Components
        </button>
      </div>
      {tab === 'layers' ? <Layers /> : <Palette />}
    </aside>
  )
}

function iconFor(el: Element): React.JSX.Element {
  if (el.localName === 'img') return <Image />
  if (el.localName === 'svg') return <Shapes />
  if (isTextLeaf(el)) return <Type />
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (cs?.display.includes('flex') || cs?.display.includes('grid')) return <LayoutGrid />
  if (cs && parseFloat(cs.borderTopLeftRadius) > 100) return <Circle />
  return <Square />
}

function nameFor(el: Element): string {
  const given = el.getAttribute('data-name')
  if (given) return given
  if (isTextLeaf(el)) {
    const text = el.textContent?.trim().replace(/\s+/g, ' ') ?? ''
    if (text) return text.length > 28 ? `${text.slice(0, 28)}…` : text
  }
  const names: Record<string, string> = {
    img: 'Image',
    svg: 'Icon',
    button: 'Button',
    header: 'Header',
    nav: 'Nav',
    footer: 'Footer',
    section: 'Section',
    main: 'Main',
    aside: 'Sidebar',
    ul: 'List',
    li: 'Item',
    a: 'Link',
    input: 'Input',
    form: 'Form',
    figure: 'Figure'
  }
  return names[el.localName] ?? (el.children.length ? 'Group' : 'Box')
}

type Zone = 'before' | 'after' | 'inside'

function Layers(): React.JSX.Element {
  const doc = useCanvas((s) => s.doc)
  const selection = useCanvas((s) => s.selection)
  const hover = useCanvas((s) => s.hover)
  useCanvas((s) => s.version)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<{ key: string; zone: Zone } | null>(null)
  const dragging = useRef<NodeRef | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const frame = getFrame()
  const selected = new Set(selection.map(refKey))

  // Open the way to whatever is selected, and bring it into view.
  const lead = selection[0]
  useEffect(() => {
    if (!lead?.nodeId || !frame) return
    const keys: string[] = []
    let cur = frame.node(lead)?.parentElement
    while (cur && !cur.classList.contains('pl-root')) {
      const id = cur.getAttribute('data-id')
      if (id) keys.push(`${lead.boardId}/${id}`)
      cur = cur.parentElement
    }
    if (keys.some((k) => !opened.has(k))) setOpened((o) => new Set([...o, ...keys]))
    setClosed((c) => (keys.some((k) => c.has(k)) ? new Set([...c].filter((k) => !keys.includes(k))) : c))
    requestAnimationFrame(() =>
      list.current?.querySelector('.dz-layer.is-selected')?.scrollIntoView({ block: 'nearest' })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.boardId, lead?.nodeId])

  const toggle = (key: string, isOpen: boolean): void => {
    const next = (set: Set<string>, add: boolean): Set<string> => {
      const copy = new Set(set)
      if (add) copy.add(key)
      else copy.delete(key)
      return copy
    }
    setOpened((o) => next(o, !isOpen))
    setClosed((c) => next(c, isOpen))
  }

  const drop = (onto: NodeRef, zone: Zone): void => {
    const from = dragging.current
    dragging.current = null
    setTarget(null)
    if (!frame || !from) return
    const el = frame.node(from)
    const dest = frame.node(onto)
    if (!el || !dest || el === dest || el.contains(dest)) return
    if (zone === 'inside') dest.appendChild(el)
    else if (zone === 'before') dest.before(el)
    else dest.after(el)
    const store = useCanvas.getState()
    store.select([{ boardId: onto.boardId, nodeId: from.nodeId }])
    store.commit()
  }

  const rows: React.JSX.Element[] = []
  const walk = (el: Element, boardId: string, depth: number): void => {
    for (const child of Array.from(el.children)) {
      const id = child.getAttribute('data-id')
      if (!id) continue
      const ref = { boardId, nodeId: id }
      const key = refKey(ref)
      const kids = child.localName !== 'svg' && !isTextLeaf(child) && child.children.length > 0
      const isOpen = kids && (opened.has(key) || (depth < 2 && !closed.has(key)))
      const hidden = (child as HTMLElement).style?.display === 'none'
      rows.push(
        <div
          key={key}
          className={`dz-layer${selected.has(key) ? ' is-selected' : ''}${hover && refKey(hover) === key ? ' is-hover' : ''}${hidden ? ' is-hidden' : ''}${target?.key === key ? ` is-drop-${target.zone}` : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            dragging.current = ref
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
          }}
          onDragOver={(e) => {
            if (!dragging.current) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const y = (e.clientY - r.top) / r.height
            const zone: Zone = y < 0.28 ? 'before' : y > 0.72 || !isContainer(child) ? 'after' : 'inside'
            if (target?.key !== key || target.zone !== zone) setTarget({ key, zone })
          }}
          onDragLeave={() => setTarget((t) => (t?.key === key ? null : t))}
          onDrop={(e) => {
            e.preventDefault()
            if (target) drop(ref, target.zone)
          }}
          onDragEnd={() => {
            dragging.current = null
            setTarget(null)
          }}
          onClick={(e) => {
            const store = useCanvas.getState()
            if (e.shiftKey || e.metaKey) {
              const has = store.selection.some((s) => refKey(s) === key)
              store.select(has ? store.selection.filter((s) => refKey(s) !== key) : [...store.selection, ref])
            } else store.select([ref])
          }}
          onPointerEnter={() => useCanvas.getState().setHover(ref)}
          onPointerLeave={() => useCanvas.getState().setHover(null)}
        >
          <button
            className={`dz-twist${kids ? '' : ' is-leaf'}${isOpen ? ' is-open' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              if (kids) toggle(key, !!isOpen)
            }}
          >
            <ChevronRight />
          </button>
          <span className="dz-layer-icon">{iconFor(child)}</span>
          <span className="dz-layer-name">{nameFor(child)}</span>
          <button
            className="dz-eye"
            title={hidden ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation()
              const node = child as HTMLElement
              if (hidden) node.style.removeProperty('display')
              else node.style.display = 'none'
              useCanvas.getState().commit()
            }}
          >
            {hidden ? <EyeOff /> : <Eye />}
          </button>
        </div>
      )
      if (isOpen) walk(child, boardId, depth + 1)
    }
  }

  for (const board of doc.artboards) {
    const ref = { boardId: board.id, nodeId: null }
    const key = refKey(ref)
    const isOpen = !closed.has(key)
    rows.push(
      <div
        key={key}
        className={`dz-layer is-board${selected.has(key) ? ' is-selected' : ''}`}
        onClick={() => useCanvas.getState().select([ref])}
        onDoubleClick={() => useCanvas.getState().fit(board.id)}
        onDragOver={(e) => dragging.current && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          drop(ref, 'inside')
        }}
      >
        <button
          className={`dz-twist${isOpen ? ' is-open' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            toggle(key, isOpen)
          }}
        >
          <ChevronRight />
        </button>
        <span className="dz-layer-icon">
          <Frame />
        </span>
        <span className="dz-layer-name">{board.name}</span>
      </div>
    )
    const root = frame?.root(board.id)
    if (isOpen && root) walk(root, board.id, 1)
  }

  return (
    <div className="dz-layers" ref={list}>
      {rows.length === 0 ? (
        <p className="dz-note">No frames yet. Ask the Designer for something, or press F and drag on the canvas.</p>
      ) : (
        rows
      )}
    </div>
  )
}

function Palette(): React.JSX.Element {
  const groups = Array.from(new Set(PALETTE.map((p) => p.group)))
  const insert = (html: string): void => {
    const store = useCanvas.getState()
    const frame = getFrame()
    const picked = store.selection[0]
    const target = picked ?? (store.doc.artboards[0] && { boardId: store.doc.artboards[0].id, nodeId: null })
    if (!frame) return
    if (!target) {
      const board = store.addBoard({ width: 480, height: 320 })
      store.insertHtml(`<div class="flex h-full w-full items-center justify-center p-8">${html}</div>`, {
        boardId: board.id,
        nodeId: null
      })
      store.fit()
      return
    }
    const el = frame.node(target)
    if (!el) return
    // Into a selected container; otherwise right after the selected layer.
    if (target.nodeId === null || isContainer(el)) {
      const root = target.nodeId === null && el.children.length === 1 && isContainer(el.children[0]) ? frame.refOf(el.children[0]) : target
      store.insertHtml(html, root ?? target)
    } else {
      const parent = frame.refOf(el.parentElement)
      const index = Array.from(el.parentElement?.children ?? []).indexOf(el) + 1
      if (parent) store.insertHtml(html, parent, index)
    }
  }
  return (
    <div className="dz-palette">
      <p className="dz-note">Drag onto a frame, or click to add to the selection.</p>
      {groups.map((group) => (
        <div key={group}>
          <h5>{group}</h5>
          <div className="dz-palette-grid">
            {PALETTE.filter((p) => p.group === group).map((item) => (
              <button
                key={item.name}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy'
                  e.dataTransfer.setData(COMPONENT_MIME, item.html)
                }}
                onClick={() => insert(item.html)}
              >
                <Component />
                <span>{item.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
