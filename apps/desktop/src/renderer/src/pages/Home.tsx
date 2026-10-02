import { ArrowUp, Paperclip } from 'lucide-react'
import { useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { AgentAvatar } from '../components/AgentAvatar'

const STARTERS = [
  'Fix the failing tests in my repo',
  'Research the best open models for on-device agents',
  'Score this pull request: ',
  'What changed in Python 3.13 that could break my code?'
]

interface Props {
  agents: AgentSummary[]
  /** Agents that can take a task from here. */
  runnable: string[]
  onBrowse: () => void
  /** Open the Coder workspace. */
  onCode: () => void
  /** Hand a task to an agent (`auto` picks one). */
  onStart: (agentId: string, text: string) => void
}

export function Home({ agents, runnable, onBrowse, onCode, onStart }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [agentId, setAgentId] = useState<string>('auto')
  const picked = agents.find((a) => a.id === agentId)
  const canRun = agentId === 'auto' || (!!picked && picked.status === 'ready' && runnable.includes(agentId))

  const submit = (): void => {
    if (!draft.trim() || !canRun) return
    onStart(agentId, draft.trim())
  }

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

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Describe a task, ask a question, or paste a pull request link…"
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
            disabled={!draft.trim() || !canRun}
            title={canRun ? 'Send (Enter)' : `${picked?.name ?? 'This agent'} is not available yet`}
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
