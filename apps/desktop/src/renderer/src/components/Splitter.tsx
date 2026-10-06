import { useCallback, useRef, useState } from 'react'

/** The narrowest the chat column may get while a side pane is dragged. */
const MIN_CHAT = 380

function recall(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

/** A pane width that survives reloads. */
export function usePaneWidth(
  key: string,
  fallback: number
): [number, (w: number) => void, () => void] {
  const [width, setWidth] = useState(() => recall(key, fallback))
  const save = useCallback(
    (w: number) => {
      const next = Math.round(w)
      setWidth(next)
      try {
        localStorage.setItem(key, String(next))
      } catch {
        /* storage can be unavailable */
      }
    },
    [key]
  )
  const reset = useCallback(() => save(fallback), [save, fallback])
  return [width, save, reset]
}

/** A pane's share of the row it sits in (0–1), surviving reloads, so it keeps its proportion as the window changes. */
export function usePaneShare(
  key: string,
  fallback: number
): [number, (share: number) => void, () => void] {
  const [share, setShare] = useState(() => {
    const stored = recall(key, fallback)
    return stored > 0 && stored < 1 ? stored : fallback
  })
  const save = useCallback(
    (next: number) => {
      const value = Math.round(next * 1000) / 1000
      setShare(value)
      try {
        localStorage.setItem(key, String(value))
      } catch {
        /* storage can be unavailable */
      }
    },
    [key]
  )
  const reset = useCallback(() => save(fallback), [save, fallback])
  return [share, save, reset]
}

/**
 * A draggable divider on the edge of a side pane. `side` is where the pane
 * sits relative to the divider: dragging toward the chat widens the pane.
 * Double-click restores the default width.
 */
export function Splitter({
  side,
  width,
  min,
  max,
  onResize,
  onReset,
  yields = ':scope > .chat',
  yieldsMin = MIN_CHAT
}: {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  onResize: (w: number) => void
  onReset: () => void
  /** The sibling that gives up room as the pane grows, and how narrow it may get. */
  yields?: string
  yieldsMin?: number
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, width: 0, room: 0 })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const workspace = e.currentTarget.parentElement
    const chat = workspace?.querySelector<HTMLElement>(yields)
    // The pane can grow only as far as the column next to it can shrink.
    const room = chat ? chat.getBoundingClientRect().width - yieldsMin : Infinity
    start.current = { x: e.clientX, width, room: Math.max(0, room) }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const dx = e.clientX - start.current.x
    const grown = side === 'left' ? dx : -dx
    const ceiling = Math.min(max, start.current.width + start.current.room)
    onResize(Math.max(min, Math.min(ceiling, start.current.width + grown)))
  }

  const stop = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  return (
    <div
      className={`splitter is-${side}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
    />
  )
}

/**
 * The three-column workspace the agent pages share:
 * rail | chat | panel, with draggable dividers between them.
 */
export function Workspace({
  rail,
  panel,
  children
}: {
  rail: React.ReactNode
  /** The right-hand panel; omit to give the chat the room. */
  panel?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [railW, setRailW, resetRail] = usePaneWidth('polly.pane.rail', 264)
  const [panelW, setPanelW, resetPanel] = usePaneWidth('polly.pane.panel', 400)
  return (
    <div
      className="coder"
      style={{ '--rail-w': `${railW}px`, '--inspector-w': `${panelW}px` } as React.CSSProperties}
    >
      {rail}
      <Splitter side="left" width={railW} min={208} max={420} onResize={setRailW} onReset={resetRail} />
      {children}
      {panel && (
        <>
          <Splitter
            side="right"
            width={panelW}
            min={300}
            max={1100}
            onResize={setPanelW}
            onReset={resetPanel}
          />
          {panel}
        </>
      )}
    </div>
  )
}
