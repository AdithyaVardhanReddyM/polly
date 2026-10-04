import { ArrowRight, Plus, Settings2, Users } from 'lucide-react'
import type { AgentSummary } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { AgentCard } from '../components/AgentCard'
import { PageHead } from '../components/PageHead'
import { GroupAvatar } from '../components/Team'
import { DIVISIONS } from '../divisions'
import { membersOf, useRoster } from '../store/roster'

interface Props {
  agents: AgentSummary[]
  server: ServerState
  /** Agents with a workspace of their own. */
  openable: string[]
  /** Open an agent's workspace, for agents that have one. */
  onOpen: (id: string) => void
  /** Open the builder: for a new agent, or to edit one of the user's. */
  onBuild: (id: string | null) => void
  /** Change which agents an agent hands work to. */
  onTeam: (id: string, teammates: string[]) => void
  onOpenGroup: (id: string) => void
  /** Open the group dialog: for a new group, or to change one. */
  onEditGroup: (id: string | null) => void
}

export function Agents({
  agents,
  server,
  openable,
  onOpen,
  onBuild,
  onTeam,
  onOpenGroup,
  onEditGroup
}: Props): React.JSX.Element {
  const groups = useRoster((s) => s.groups)
  return (
    <div className="page">
      <PageHead
        title="Agents"
        subtitle="Built-in specialists, grouped by division, and the ones you make yourself."
      >
        <div className="page-actions">
          <button className="btn" onClick={() => onEditGroup(null)}>
            <Users /> New group
          </button>
          <button className="btn btn-primary" onClick={() => onBuild(null)}>
            <Plus /> New agent
          </button>
        </div>
      </PageHead>

      {agents.length === 0 && (
        <div className="empty">
          {server.checking
            ? 'Loading agents…'
            : 'No agents to show. Start the agent server with `npm run dev:server`.'}
        </div>
      )}

      {groups.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Groups</h2>
            <span>Agents you talk to together. One leads and brings the others in.</span>
          </div>
          <div className="agent-grid">
            {groups.map((g) => {
              const members = membersOf(g, agents)
              return (
                <article key={g.id} className="agent-card is-openable">
                  <div className="agent-card-head">
                    <GroupAvatar members={members} size={44} />
                    <button
                      className="icon-btn"
                      onClick={() => onEditGroup(g.id)}
                      title={`Edit ${g.name}`}
                    >
                      <Settings2 />
                    </button>
                  </div>
                  <div>
                    <h3>{g.name}</h3>
                    <p className="agent-tagline">
                      {members.length} agents{members[0] ? ` · ${members[0].name} leads` : ''}
                    </p>
                  </div>
                  <p className="agent-desc">{members.map((a) => a.name).join(', ')}</p>
                  <button className="btn btn-primary agent-open" onClick={() => onOpenGroup(g.id)}>
                    Open {g.name} <ArrowRight />
                  </button>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {DIVISIONS.map((d) => {
        const inDivision = agents.filter((a) => a.division === d.id)
        if (d.id !== 'custom' && inDivision.length === 0) return null
        if (d.id === 'custom' && agents.length === 0) return null
        return (
          <section key={d.id}>
            <div className="section-head">
              <h2>{d.label}</h2>
              <span>{d.blurb}</span>
            </div>
            <div className="agent-grid">
              {inDivision.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  onOpen={
                    a.status === 'ready' && openable.includes(a.id) ? () => onOpen(a.id) : undefined
                  }
                  onEdit={a.custom ? () => onBuild(a.id) : undefined}
                  onTeam={a.status === 'ready' ? (ids) => onTeam(a.id, ids) : undefined}
                />
              ))}
              {d.id === 'custom' && (
                <button className="agent-card is-new" onClick={() => onBuild(null)}>
                  <Plus />
                  Create an agent
                  <small>Instructions, a model, tools and apps</small>
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
