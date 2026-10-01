import { SquareTerminal } from 'lucide-react'
import type { AgentSummary } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { AgentAvatar } from '../components/AgentAvatar'
import { PageHead } from '../components/PageHead'

interface Props {
  agents: AgentSummary[]
  server: ServerState
}

export function Computers({ agents, server }: Props): React.JSX.Element {
  const withComputer = agents.filter((a) => a.computer)
  const sandbox = server.health?.sandbox

  return (
    <div className="page">
      <PageHead
        title="Computers"
        subtitle="Every agent gets a sandbox to run code, and a full desktop when the job needs one."
      />

      <div className="stats">
        <div className="stat is-brand">
          <small>Sandbox provider</small>
          <b>{sandbox?.provider ?? '—'}</b>
        </div>
        <div className="stat">
          <small>Running</small>
          <b>0</b>
        </div>
        <div className="stat">
          <small>Agents with a computer</small>
          <b>{withComputer.length}</b>
        </div>
      </div>

      <section>
        <div className="section-head">
          <h2>Machines</h2>
        </div>
        <div className="list">
          {withComputer.length === 0 && <div className="row is-quiet">No agents yet.</div>}
          {withComputer.map((a) => (
            <div key={a.id} className="row">
              <AgentAvatar agent={a} size={34} />
              <div className="row-body">
                <div className="row-title">{a.name}’s computer</div>
                <div className="row-why">Linux desktop · starts on demand</div>
              </div>
              <span className="status">
                <span className="dot dot-down" /> Stopped
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="strip">
        <span>
          <SquareTerminal /> Code runs in isolated sandboxes, never on this Mac.
        </span>
      </div>
    </div>
  )
}
