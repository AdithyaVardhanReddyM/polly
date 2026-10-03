import { useEffect, useState } from 'react'
import type { Rect } from './model'
import type { Presence } from './store'

const PHRASES = ['Finding the vibe', 'Laying it out', 'Choosing type', 'Balancing colour', 'Polishing']

/**
 * The agent at work on an artboard: a coloured outline, a cursor with a
 * label, and a field of dots that ripples around it. While the artboard is
 * still empty the cursor wanders; once the agent edits a node it goes there.
 */
export function AgentPresence({
  rect,
  presence
}: {
  rect: Rect
  presence: Presence
}): React.JSX.Element {
  const [spot, setSpot] = useState({ x: presence.x, y: presence.y })
  const [phrase, setPhrase] = useState(0)

  useEffect(() => {
    if (!presence.building) {
      setSpot({ x: presence.x, y: presence.y })
      return
    }
    const wander = (): void =>
      setSpot({ x: 0.18 + Math.random() * 0.64, y: 0.2 + Math.random() * 0.6 })
    const first = setTimeout(wander, 60)
    const move = setInterval(wander, 1300)
    const talk = setInterval(() => setPhrase((n) => n + 1), 2600)
    return () => {
      clearTimeout(first)
      clearInterval(move)
      clearInterval(talk)
    }
  }, [presence.building, presence.x, presence.y])

  const x = spot.x * rect.width
  const y = spot.y * rect.height
  const label =
    presence.building && presence.label === 'Finding the vibe'
      ? PHRASES[phrase % PHRASES.length]
      : presence.label

  return (
    <div
      className={`dz-presence${presence.building ? ' is-building' : ''}`}
      style={
        {
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          '--dz-agent': presence.color,
          '--dz-cx': `${x}px`,
          '--dz-cy': `${y}px`,
          '--dz-reach': `${Math.max(28, Math.min(rect.width, rect.height) * 0.32)}px`
        } as React.CSSProperties
      }
    >
      <div className="dz-dots" />
      <div className="dz-cursor" style={{ transform: `translate(${x}px, ${y}px)` }}>
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d="M2 1.5l11 5.2-4.6 1.5L6.8 13z" fill="currentColor" />
        </svg>
        <span>{label}</span>
      </div>
    </div>
  )
}
