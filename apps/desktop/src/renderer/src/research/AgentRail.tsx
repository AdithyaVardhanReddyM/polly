import { SquarePen } from 'lucide-react'
import { SessionRow } from '../coder/ProjectRail'
import type { AgentStore } from '../store/agentSession'

/** Sessions of a project-less agent: a heading, "New", and the list. */
export function AgentRail({
  store,
  title,
  subtitle,
  icon,
  newLabel,
  empty,
  only
}: {
  store: AgentStore
  title: string
  subtitle: string
  icon: React.JSX.Element
  newLabel: string
  empty: string
  /** List one agent's sessions, in a store that covers several. */
  only?: string
}): React.JSX.Element {
  const every = store((s) => s.sessions)
  const sessions = only ? every.filter((s) => s.agent_id === only) : every
  const sessionId = store((s) => s.sessionId)
  const open = store((s) => s.open)
  const remove = store((s) => s.remove)
  const newSession = store((s) => s.newSession)

  return (
    <aside className="rail">
      <header className="rail-head">
        <div className="project-switch is-static" title={subtitle}>
          <span className="project-glyph">{icon}</span>
          <span className="project-name">{title}</span>
        </div>
        <button className="icon-btn rail-new" title={newLabel} onClick={newSession}>
          <SquarePen />
        </button>
      </header>

      <div className="rail-section sessions">
        <div className="rail-label">History</div>
        <div className="session-list">
          {sessions.length === 0 && <div className="rail-empty">{empty}</div>}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === sessionId}
              fallbackTitle="Untitled"
              onOpen={() => void open(s.id)}
              onDelete={() => {
                if (window.confirm('Delete this session?')) void remove(s.id)
              }}
            />
          ))}
        </div>
      </div>
    </aside>
  )
}
