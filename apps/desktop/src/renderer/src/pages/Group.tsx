import {
  CircleAlert,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { outputUrl, serverUrl } from '../api'
import { AskCard } from '../coder/AskCard'
import { OutputContext } from '../coder/Markdown'
import { TranscriptView } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Workspace } from '../components/Splitter'
import { GroupAvatar } from '../components/Team'
import { AgentComposer } from '../research/AgentComposer'
import { AgentRail } from '../research/AgentRail'
import { SourcesPanel } from '../research/Sources'
import { useGroupChat } from '../store/agentSession'
import { membersOf, useRoster } from '../store/roster'

interface Props {
  agents: AgentSummary[]
  onEdit: (id: string) => void
  onCreate: () => void
}

/** A conversation with a group of agents: one leads, the others join in. */
export function Group({ agents, onEdit, onCreate }: Props): React.JSX.Element {
  const boot = useGroupChat((s) => s.boot)
  const session = useGroupChat((s) => s.session)
  const sessionId = useGroupChat((s) => s.sessionId)
  const items = useGroupChat((s) => s.items)
  const run = useGroupChat((s) => s.run)
  const approval = useGroupChat((s) => s.approval)
  const decide = useGroupChat((s) => s.decide)
  const sources = useGroupChat((s) => s.sources)
  const error = useGroupChat((s) => s.error)
  const clearError = useGroupChat((s) => s.clearError)
  const groupId = useGroupChat((s) => s.agentId)
  const groups = useRoster((s) => s.groups)
  const [panel, setPanel] = useState(false)
  const [base, setBase] = useState<string | null>(null)

  useEffect(() => {
    void boot()
    void serverUrl().then(setBase)
  }, [boot])

  const group = groups.find((g) => g.id === (session?.group_id ?? groupId))
  const resolve = useMemo(
    () => (base && sessionId ? (path: string) => outputUrl(base, sessionId, path) : null),
    [base, sessionId]
  )

  if (!group) {
    return (
      <div className="coder-starters">
        <h2>Put your agents in a group</h2>
        <p className="research-blurb">
          Talk to several agents at once. One leads, and brings the others in when the work is theirs.
        </p>
        <button className="btn btn-primary" onClick={onCreate}>
          <Plus /> New group
        </button>
      </div>
    )
  }

  // A conversation keeps the lead it started with, even if the group's lead changed since.
  const members = membersOf(group, agents, session?.agent_id ?? group.lead)
  const lead = members[0]
  const others = members.slice(1)
  const empty = items.length === 0 && !session
  const showSources = panel && sources.length > 0

  return (
    <Workspace
      rail={
        <AgentRail
          store={useGroupChat}
          title={group.name}
          subtitle={members.map((a) => a.name).join(', ')}
          icon={<GroupAvatar members={members} size={20} />}
          newLabel="New conversation"
          empty="No conversations yet."
          group={group.id}
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
          <GroupAvatar members={members} size={28} />
          <div className="chat-title">
            <b>{session?.title || group.name}</b>
            <span>
              {session?.title ? `${group.name} · ` : ''}
              {members.length} agents{lead ? ` · ${lead.name} leads` : ''}
            </span>
          </div>
          <span className={`run-state is-${run}`}>
            {run === 'running' ? 'Working' : run === 'awaiting_approval' ? 'Waiting for you' : ''}
          </span>
          <button className="icon-btn" title={`Edit ${group.name}`} onClick={() => onEdit(group.id)}>
            <Settings2 />
          </button>
          {sources.length > 0 && (
            <button
              className="icon-btn"
              title={panel ? 'Hide sources' : 'Show sources'}
              onClick={() => setPanel(!panel)}
            >
              {panel ? <PanelRightClose /> : <PanelRightOpen />}
            </button>
          )}
        </header>

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
            <GroupAvatar members={members} size={84} />
            <h2>{group.name}</h2>
            <p className="research-blurb">
              {lead
                ? `${lead.name} leads: it reads your message, brings in whoever the work belongs to and gives the answer. Type @ to ask an agent directly.`
                : 'This group has no agents left. Edit it to add some.'}
            </p>
            <div className="group-members">
              {members.map((a) => (
                <span key={a.id} className="group-member" title={a.tagline}>
                  <AgentAvatar agent={a} size={22} bare />
                  {a.name}
                  {a.id === lead?.id && <em className="badge">Lead</em>}
                </span>
              ))}
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
              agent={lead}
              speakers
              footer={<AskCard store={useGroupChat} />}
            />
          </OutputContext.Provider>
        )}

        <AgentComposer
          store={useGroupChat}
          disabled={!lead}
          defaultModel={lead?.model ?? ''}
          mentionable={others}
          placeholder={session ? 'Reply to the group…' : `Message ${group.name}…`}
        />
      </section>
    </Workspace>
  )
}
