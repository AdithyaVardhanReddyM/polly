import {
  Brain,
  CircleAlert,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plug,
  Plus,
  SquareTerminal,
  TriangleAlert,
  Users,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { outputUrl, serverUrl } from '../api'
import { OutputContext } from '../coder/Markdown'
import { TranscriptView } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Workspace } from '../components/Splitter'
import { TeamButton } from '../components/Team'
import { AgentComposer } from '../research/AgentComposer'
import { AgentRail } from '../research/AgentRail'
import { SourcesPanel } from '../research/Sources'
import { useChat } from '../store/agentSession'
import { joinable, teamOf, useRoster } from '../store/roster'

interface Props {
  agents: AgentSummary[]
  server: ServerState
  onEdit: (id: string) => void
  onCreate: () => void
}

/** A conversation with an agent the user made. */
export function Chat({ agents, server, onEdit, onCreate }: Props): React.JSX.Element {
  const boot = useChat((s) => s.boot)
  const session = useChat((s) => s.session)
  const sessionId = useChat((s) => s.sessionId)
  const items = useChat((s) => s.items)
  const run = useChat((s) => s.run)
  const approval = useChat((s) => s.approval)
  const decide = useChat((s) => s.decide)
  const sources = useChat((s) => s.sources)
  const error = useChat((s) => s.error)
  const clearError = useChat((s) => s.clearError)
  const agentId = useChat((s) => s.agentId)
  const members = useChat((s) => s.members)
  const everyone = useRoster((s) => s.open)
  const [panel, setPanel] = useState(true)
  const [base, setBase] = useState<string | null>(null)

  useEffect(() => {
    void boot()
    void serverUrl().then(setBase)
  }, [boot])

  const agent = agents.find((a) => a.id === (session?.agent_id ?? agentId))
  const searches = !!agent?.tools.includes('research_search')
  const h = server.health
  const resolve = useMemo(
    () => (base && sessionId ? (path: string) => outputUrl(base, sessionId, path) : null),
    [base, sessionId]
  )

  if (!agent) {
    return (
      <div className="coder-starters">
        <h2>
          Make an agent of <em>your own</em>
        </h2>
        <p className="research-blurb">
          Give it a name, instructions, a model and the tools it needs.
        </p>
        <button className="btn btn-primary" onClick={onCreate}>
          <Plus /> New agent
        </button>
      </div>
    )
  }

  const empty = items.length === 0 && !session
  const showSources = searches && panel
  const team = teamOf(agents, agent, members, everyone)
  // Anyone who can be called on can be addressed: an @ brings them into the chat.
  const mentionable = joinable(agents).filter((a) => a.id !== agent.id)

  return (
    <Workspace
      rail={
        <AgentRail
          store={useChat}
          title={agent.name}
          subtitle={agent.tagline}
          icon={<AgentAvatar agent={agent} size={18} bare />}
          newLabel="New chat"
          empty="No conversations yet."
          only={agent.id}
        />
      }
      panel={
        showSources ? (
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
          <AgentAvatar agent={agent} size={24} active={run === 'running'} />
          <div className="chat-title">
            <b>{session?.title || 'New chat'}</b>
            <span>{agent.name}</span>
          </div>
          <span className={`run-state is-${run}`}>
            {run === 'running' ? 'Working' : run === 'awaiting_approval' ? 'Needs approval' : ''}
          </span>
          <TeamButton store={useChat} lead={agent} />
          <button className="icon-btn" title={`Edit ${agent.name}`} onClick={() => onEdit(agent.id)}>
            <Pencil />
          </button>
          {searches && (
            <button
              className="icon-btn"
              title={panel ? 'Hide sources' : 'Show sources'}
              onClick={() => setPanel(!panel)}
            >
              {panel ? <PanelRightClose /> : <PanelRightOpen />}
            </button>
          )}
        </header>

        {agent.sandbox && h && !h.sandbox.configured && (
          <div className="banner is-warn">
            <TriangleAlert />
            <span>
              {agent.name} cannot run code yet.{' '}
              {h.sandbox.provider === 'NVIDIA OpenShell' ? (
                <>
                  Start an OpenShell gateway (<code>openshell status</code>) and restart the
                  server.
                </>
              ) : (
                <>
                  Add <code>NEBIUS_PROJECT_ID</code> to <code>.env</code> and restart the server.
                </>
              )}
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
          <div className="coder-starters">
            <AgentAvatar agent={agent} size={84} motion="slow" />
            <h2>
              <em>{agent.name}</em>
            </h2>
            <p className="research-blurb">{agent.description || agent.tagline}</p>
            <div className="agent-tags chat-abilities">
              {searches && (
                <span>
                  <Globe /> Web search
                </span>
              )}
              {agent.sandbox && (
                <span>
                  <SquareTerminal /> Code sandbox
                </span>
              )}
              {agent.memory && (
                <span>
                  <Brain /> Memory
                </span>
              )}
              {agent.integrations.length > 0 && (
                <span>
                  <Plug /> {agent.integrations.length} app
                  {agent.integrations.length === 1 ? '' : 's'}
                </span>
              )}
              {team.length > 0 && (
                <span title={team.map((a) => a.name).join(', ')}>
                  <Users /> {team.length} teammate{team.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        ) : (
          <OutputContext.Provider value={resolve}>
            <TranscriptView
              items={items}
              run={run}
              approval={approval}
              onDecide={decide}
              sources={sources}
              agent={agent}
            />
          </OutputContext.Provider>
        )}

        <AgentComposer
          store={useChat}
          mentionable={mentionable}
          defaultModel={agent?.model ?? ''}
          placeholder={session ? 'Reply…' : `Message ${agent.name}…`}
        />
      </section>
    </Workspace>
  )
}
