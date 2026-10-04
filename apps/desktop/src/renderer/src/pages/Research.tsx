import {
  CircleAlert,
  PanelRightClose,
  PanelRightOpen,
  Telescope,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { TranscriptView } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Workspace } from '../components/Splitter'
import { TeamButton } from '../components/Team'
import { AgentComposer } from '../research/AgentComposer'
import { AgentRail } from '../research/AgentRail'
import { SourcesPanel } from '../research/Sources'
import { useResearch } from '../store/agentSession'
import { joinable } from '../store/roster'

const DEPTHS = [
  {
    id: 'researcher',
    label: 'Quick',
    blurb: 'Researcher on Nemotron Super: a few searches, a cited answer in about a minute.'
  },
  {
    id: 'deep-research',
    label: 'Deep',
    blurb:
      'Deep Research: plans, sends Nemotron Nano scouts in parallel, and has Nemotron Ultra critique the draft before you see it.'
  }
]

const STARTERS = [
  'What changed in React 19 that breaks existing apps, and how do I migrate?',
  'Compare open-weight models for running a coding agent on one GPU',
  'Is FastAPI safe to upgrade from 0.110 to the latest release? Breaking changes and CVEs',
  'What is the current state of the Model Context Protocol spec?'
]

export function Research({
  agents,
  searchReady
}: {
  agents: AgentSummary[]
  searchReady: boolean
}): React.JSX.Element {
  const boot = useResearch((s) => s.boot)
  const session = useResearch((s) => s.session)
  const items = useResearch((s) => s.items)
  const run = useResearch((s) => s.run)
  const sources = useResearch((s) => s.sources)
  const error = useResearch((s) => s.error)
  const clearError = useResearch((s) => s.clearError)
  const agentId = useResearch((s) => s.agentId)
  const [panel, setPanel] = useState(true)

  useEffect(() => {
    void boot()
  }, [boot])

  const agent = agents.find((a) => a.id === (session?.agent_id ?? agentId))
  const empty = items.length === 0 && !session

  return (
    <Workspace
      rail={
        <AgentRail
          store={useResearch}
          title="Research"
          subtitle="Cited answers from the live web"
          icon={<Telescope />}
          newLabel="New research"
          empty="Nothing researched yet."
        />
      }
      panel={
        panel ? (
          <aside className="inspector">
            <div className="inspector-tabs">
              <span className="itab is-active">Sources</span>
            </div>
            <div className="inspector-body">
              <SourcesPanel sources={sources} running={run === 'running'} />
            </div>
          </aside>
        ) : null
      }
    >
      <section className="chat">
        <header className="chat-head">
          {agent && <AgentAvatar agent={agent} size={24} active={run === 'running'} />}
          <div className="chat-title">
            <b>{session?.title || 'New research'}</b>
            {agent && <span>{agent.name}</span>}
          </div>
          <span className={`run-state is-${run}`}>{run === 'running' ? 'Researching' : ''}</span>
          {agent && <TeamButton store={useResearch} lead={agent} />}
          <button
            className="icon-btn"
            title={panel ? 'Hide sources' : 'Show sources'}
            onClick={() => setPanel(!panel)}
          >
            {panel ? <PanelRightClose /> : <PanelRightOpen />}
          </button>
        </header>

        {!searchReady && (
          <div className="banner is-warn">
            <TriangleAlert />
            <span>
              Research needs web search. Add <code>TAVILY_API_KEY</code> to <code>.env</code>{' '}
              and restart the server.
            </span>
          </div>
        )}
        {error && (
          <div className="banner is-error">
            <CircleAlert />
            <span>{error}</span>
            <button className="icon-btn" onClick={clearError} title="Dismiss">
              <X />
            </button>
          </div>
        )}

        {empty ? (
          <ResearchStart disabled={!searchReady} />
        ) : (
          <TranscriptView items={items} run={run} sources={sources} agent={agent} />
        )}

        <AgentComposer
          store={useResearch}
          disabled={!searchReady}
          mentionable={joinable(agents).filter((a) => a.id !== agent?.id)}
          placeholder={session ? 'Ask a follow-up…' : 'What should Polly research?'}
        >
          {!session && <DepthSwitch />}
        </AgentComposer>
      </section>
    </Workspace>
  )
}

function DepthSwitch(): React.JSX.Element {
  const agentId = useResearch((s) => s.agentId)
  const setAgent = useResearch((s) => s.setAgent)
  return (
    <div className="segmented" role="radiogroup" aria-label="Depth">
      {DEPTHS.map((d) => (
        <button
          key={d.id}
          role="radio"
          aria-checked={agentId === d.id}
          className={agentId === d.id ? 'is-active' : ''}
          title={d.blurb}
          onClick={() => setAgent(d.id)}
        >
          {d.label}
        </button>
      ))}
    </div>
  )
}

function ResearchStart({ disabled }: { disabled: boolean }): React.JSX.Element {
  const send = useResearch((s) => s.send)
  const agentId = useResearch((s) => s.agentId)
  const depth = DEPTHS.find((d) => d.id === agentId) ?? DEPTHS[0]
  return (
    <div className="coder-starters">
      <div className="welcome-mark is-research">
        <Telescope />
      </div>
      <h2>
        What should we <em>find out?</em>
      </h2>
      <p className="research-blurb">{depth.blurb}</p>
      <div className="starter-grid">
        {STARTERS.map((s) => (
          <button key={s} className="starter" disabled={disabled} onClick={() => void send(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
