import { Plus } from 'lucide-react'
import type { AgentSummary } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { AgentCard } from '../components/AgentCard'
import { PageHead } from '../components/PageHead'
import { DIVISIONS } from '../divisions'

interface Props {
  agents: AgentSummary[]
  server: ServerState
  /** Agents with a workspace of their own. */
  openable: string[]
  /** Open an agent's workspace, for agents that have one. */
  onOpen: (id: string) => void
}

export function Agents({ agents, server, openable, onOpen }: Props): React.JSX.Element {
  return (
    <div className="page">
      <PageHead
        title="Agents"
        subtitle="Built-in specialists, grouped by division, and the ones you make yourself."
      >
        <button className="btn btn-primary" disabled title="Agent builder is coming">
          <Plus /> New agent
        </button>
      </PageHead>

      {agents.length === 0 && (
        <div className="empty">
          {server.checking
            ? 'Loading agents…'
            : 'No agents to show. Start the agent server with `npm run dev:server`.'}
        </div>
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
                />
              ))}
              {d.id === 'custom' && (
                <button className="agent-card is-new" disabled>
                  <Plus />
                  Create an agent
                  <small>Instructions, skills, knowledge and tools</small>
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
