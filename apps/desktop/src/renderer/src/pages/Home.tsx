import { ArrowUp, Paperclip } from 'lucide-react'
import { useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { AgentAvatar } from '../components/AgentAvatar'

const STARTERS = [
  'Fix the failing tests in my repo and open a PR',
  'Research the best open models for on-device agents',
  'Draft replies to everything in my inbox that needs one',
  'Turn these notes into a 10-slide deck'
]

interface Props {
  agents: AgentSummary[]
  onBrowse: () => void
  /** Open the Coder workspace. */
  onCode: () => void
}

export function Home({ agents, onBrowse, onCode }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [agentId, setAgentId] = useState<string>('auto')

  return (
    <div className="home">
      <div className="home-hero">
        {agents.length > 0 && (
          <div className="crew">
            {agents.map((a) => (
              <button
                key={a.id}
                className={a.id === agentId ? 'crew-bot is-picked' : 'crew-bot'}
                title={`${a.name} — ${a.tagline}`}
                onClick={() => (a.id === 'coder' ? onCode() : setAgentId(a.id === agentId ? 'auto' : a.id))}
              >
                <AgentAvatar agent={a} size={40} />
              </button>
            ))}
          </div>
        )}
        <h1 className="home-title">
          What should we <em>work on?</em>
        </h1>
        <p className="home-sub">
          Hand it to an agent. Each one has its own tools, memory and computer.
        </p>
      </div>

      <form className="composer" onSubmit={(e) => e.preventDefault()}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Describe a task…"
          rows={3}
        />
        <div className="composer-bar">
          <button type="button" className="icon-btn" title="Attach" disabled>
            <Paperclip />
          </button>
          <select
            className="composer-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="auto">Auto-pick agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="send"
            disabled
            title="Agents are not wired up yet"
          >
            <ArrowUp />
          </button>
        </div>
      </form>

      <div className="starters">
        {STARTERS.map((s) => (
          <button key={s} className="starter" onClick={() => setDraft(s)}>
            {s}
          </button>
        ))}
      </div>

      <p className="home-foot">
        {agents.length > 0 ? `${agents.length} agents in the workspace · ` : ''}
        <button className="link" onClick={onCode}>
          Open Coder
        </button>
        {' · '}
        <button className="link" onClick={onBrowse}>
          Browse agents
        </button>
      </p>
    </div>
  )
}
