import { Plus, Trash2 } from 'lucide-react'
import { StatusDot } from '../coder/ProjectRail'
import { relativeTime } from '../coder/toolMeta'
import type { AgentStore } from '../store/agentSession'

/** Sessions of a project-less agent: a heading, "New", and the list. */
export function AgentRail({
  store,
  title,
  subtitle,
  icon,
  newLabel,
  empty
}: {
  store: AgentStore
  title: string
  subtitle: string
  icon: React.JSX.Element
  newLabel: string
  empty: string
}): React.JSX.Element {
  const sessions = store((s) => s.sessions)
  const sessionId = store((s) => s.sessionId)
  const open = store((s) => s.open)
  const remove = store((s) => s.remove)
  const newSession = store((s) => s.newSession)

  return (
    <aside className="rail">
      <div className="project-switch is-static">
        <span className="project-icon is-research">{icon}</span>
        <span className="project-name">
          <b>{title}</b>
          <span>{subtitle}</span>
        </span>
      </div>

      <button className="new-session" onClick={newSession}>
        <Plus /> {newLabel}
      </button>

      <div className="rail-section sessions is-tall">
        <div className="rail-label">History</div>
        {sessions.length === 0 && <div className="rail-empty">{empty}</div>}
        {sessions.map((s) => (
          <div key={s.id} className={s.id === sessionId ? 'session-row is-active' : 'session-row'}>
            <button className="session-main" onClick={() => void open(s.id)}>
              <StatusDot session={s} />
              <span className="session-title">{s.title || 'Untitled'}</span>
              <span className="session-time">{relativeTime(s.updated_at)}</span>
            </button>
            <button
              className="icon-btn session-delete"
              title="Delete"
              onClick={() => {
                if (window.confirm('Delete this session?')) void remove(s.id)
              }}
            >
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
