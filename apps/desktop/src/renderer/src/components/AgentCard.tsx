import { Monitor, Timer } from 'lucide-react'
import type { AgentSummary } from '../../../shared/contracts'
import { AgentAvatar } from './AgentAvatar'

const STATUS_LABEL: Record<AgentSummary['status'], string> = {
  ready: 'Ready',
  building: 'In progress',
  planned: 'Planned'
}

export function AgentCard({ agent }: { agent: AgentSummary }): React.JSX.Element {
  return (
    <article className="agent-card">
      <div className="agent-card-head">
        <AgentAvatar agent={agent} size={44} />
        <span className={`status status-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
      </div>
      <div>
        <h3>{agent.name}</h3>
        <p className="agent-tagline">{agent.tagline}</p>
      </div>
      <p className="agent-desc">{agent.description}</p>
      <div className="agent-tags">
        {agent.runtime === 'deep' && (
          <span className="tag-long" title="Runs as a Deep Agent: plans, delegates, works for as long as it takes">
            <Timer /> Long-running
          </span>
        )}
        {agent.computer && (
          <span className="tag-computer">
            <Monitor /> Own computer
          </span>
        )}
        {agent.tools.slice(0, 4).map((t) => (
          <span key={t}>{t}</span>
        ))}
        {agent.tools.length > 4 && <span>+{agent.tools.length - 4}</span>}
      </div>
    </article>
  )
}
