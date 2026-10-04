import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentSummary, ServerHealth } from '../../shared/contracts'
import { api } from './api'
import { GroupDialog } from './components/GroupDialog'
import { homeOf, SECTIONS, Sidebar, type Section, useSidebarCollapsed } from './components/Sidebar'
import { Agents } from './pages/Agents'
import { Builder } from './pages/Builder'
import { Chat } from './pages/Chat'
import { Coder } from './pages/Coder'
import { Computers } from './pages/Computers'
import { Design } from './pages/Design'
import { Group } from './pages/Group'
import { Home } from './pages/Home'
import { Integrations } from './pages/Integrations'
import { Research } from './pages/Research'
import { PR_URL, Review } from './pages/Review'
import { Routines } from './pages/Routines'
import { Settings } from './pages/Settings'
import { useDesign } from './design/session'
import {
  AGENTS_CHANGED,
  useChat,
  useGroupChat,
  useResearch,
  useReview
} from './store/agentSession'
import { useCoder } from './store/coder'
import { useRoster } from './store/roster'

export interface ServerState {
  health: ServerHealth | null
  error: string | null
  checking: boolean
}

const ALL_SECTIONS: readonly Section[] = [...SECTIONS, 'Settings']

const DESIGNING =
  /\b(design|redesign|mock ?up|wireframe|poster|banner|flyer|logo|landing page|ui for|screen for)\b/i
const CODING = /\b(fix|implement|refactor|debug|bug|failing tests?|write (a )?tests?|add .+ to (my|the|this))\b/i

/** The open section lives in the URL hash (`#coder/<session>` deep-links a
 *  session), so a reload — or a link — lands on it. */
function sectionFromHash(): Section {
  const id = window.location.hash.slice(1).split('/')[0].toLowerCase()
  return ALL_SECTIONS.find((s) => s.toLowerCase() === id) ?? 'Home'
}

export default function App(): React.JSX.Element {
  const [section, setSection] = useState<Section>(sectionFromHash)
  const [server, setServer] = useState<ServerState>({ health: null, error: null, checking: true })
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [collapsed, toggleSidebar] = useSidebarCollapsed()
  // The custom agent open in the builder; null there means a new one.
  const [editing, setEditing] = useState<string | null>(
    () => window.location.hash.match(/^#builder\/([\w-]+)/)?.[1] ?? null
  )
  const groups = useRoster((s) => s.groups)
  // The group dialog: `id` is the group being changed, null a new one.
  const [groupDialog, setGroupDialog] = useState<{ id: string | null } | null>(null)

  const refresh = useCallback(async () => {
    setServer((s) => ({ ...s, checking: true }))
    const [health, catalog] = await Promise.all([api.health(), api.agents()])
    setServer({
      health: health.ok ? health.data : null,
      error: health.ok ? null : health.error,
      checking: false
    })
    if (catalog.ok) setAgents(catalog.data)
    // Groups follow the agents: deleting one reshapes the groups it was in.
    void useRoster.getState().load()
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Polly made an agent in a conversation.
  useEffect(() => {
    const onChange = (): void => void refresh()
    window.addEventListener(AGENTS_CHANGED, onChange)
    return () => window.removeEventListener(AGENTS_CHANGED, onChange)
  }, [refresh])

  useEffect(() => {
    const current = window.location.hash.slice(1).split('/')[0].toLowerCase()
    if (current !== section.toLowerCase()) {
      window.history.replaceState(null, '', `#${section.toLowerCase()}`)
    }
  }, [section])

  // The chat workspace covers Polly and whichever agents the user has made.
  useEffect(() => {
    useRoster.getState().setAgents(agents)
    useChat
      .getState()
      .setAgentIds(
        [...agents.filter((a) => a.orchestrator), ...agents.filter((a) => a.custom)].map((a) => a.id)
      )
  }, [agents])

  // And the group workspace, whichever groups.
  useEffect(() => {
    useGroupChat.getState().setAgentIds(groups.map((g) => g.id))
  }, [groups])

  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const runnable = useMemo(
    () => agents.filter((a) => a.status === 'ready' && homeOf(a)).map((a) => a.id),
    [agents]
  )

  const flush = ['Coder', 'Design', 'Research', 'Review', 'Chat', 'Group', 'Builder'].includes(
    section
  )

  const build = (id: string | null): void => {
    setEditing(id)
    setSection('Builder')
    window.history.replaceState(null, '', id ? `#builder/${id}` : '#builder')
  }

  /** A new conversation with one of the user's agents. */
  const newChat = (id: string): void => {
    useChat.getState().newSession()
    useChat.getState().setAgent(id)
    setSection('Chat')
  }

  /** A task from Home: a PR link goes to the Reviewer, code work to the
   *  Coder, design work to the Designer, everything else to research. */
  const start = async (agentId: string, text: string): Promise<void> => {
    const pr = text.match(PR_URL)?.[0]
    const target =
      agentId !== 'auto'
        ? agentId
        : pr
          ? 'reviewer'
          : CODING.test(text)
            ? 'coder'
            : DESIGNING.test(text)
              ? 'designer'
              : 'researcher'
    if (target === 'reviewer') {
      setSection('Review')
      if (pr) {
        useReview.getState().newSession()
        await useReview.getState().review(pr)
      }
      return
    }
    if (target === 'coder') {
      setSection('Coder')
      const coder = useCoder.getState()
      if (!coder.projectId) await coder.boot()
      if (useCoder.getState().projectId) {
        await useCoder.getState().newSession()
        await useCoder.getState().send(text)
      }
      return
    }
    if (target === 'designer') {
      setSection('Design')
      useDesign.getState().newSession()
      await useDesign.getState().send(text)
      return
    }
    const chosen = byId.get(target)
    if (chosen && homeOf(chosen) === 'Chat') {
      newChat(target)
      await useChat.getState().send(text)
      return
    }
    setSection('Research')
    const research = useResearch.getState()
    research.newSession()
    research.setAgent(target)
    await research.send(text)
  }

  const openAgent = (id: string): void => {
    const agent = byId.get(id)
    const home = agent && homeOf(agent)
    if (!home) return
    if (home === 'Chat') return newChat(id)
    if (id === 'designer') useDesign.getState().newSession()
    if (id === 'researcher' || id === 'deep-research') {
      useResearch.getState().newSession()
      useResearch.getState().setAgent(id)
    }
    setSection(home)
  }

  /** From the sidebar: back to the agent's workspace as it was left. */
  const chatWith = (id: string): void => {
    const agent = byId.get(id)
    const home = agent && homeOf(agent)
    if (!home) return
    if (home === 'Chat') {
      const chat = useChat.getState()
      if ((chat.session?.agent_id ?? chat.agentId) !== id) {
        // Back to the last conversation with this agent, if there was one.
        const last = chat.sessions.find((s) => s.agent_id === id)
        if (last) void chat.open(last.id)
        else newChat(id)
      }
    }
    if (home === 'Research') {
      const research = useResearch.getState()
      if ((research.session?.agent_id ?? research.agentId) !== id) {
        research.newSession()
        research.setAgent(id)
      }
    }
    setSection(home)
  }

  /** A group's workspace as it was left: its last conversation, or a new one. */
  const openGroup = (id: string, fresh = false): void => {
    const chat = useGroupChat.getState()
    // A group made a moment ago is not in the store's list until the next render.
    chat.setAgentIds([...new Set([...chat.agentIds, id])])
    const store = useGroupChat.getState()
    if (fresh || (store.session?.group_id ?? store.agentId) !== id || !store.session) {
      const last = fresh ? undefined : store.sessions.find((s) => s.group_id === id)
      if (last) void store.open(last.id)
      else {
        store.newSession()
        store.setAgent(id)
      }
    }
    setSection('Group')
  }

  /** Change the agents an agent hands work to, from its card. */
  const setTeam = async (id: string, teammates: string[]): Promise<void> => {
    const res = await api.team.set(id, teammates)
    if (res.ok) setAgents((all) => all.map((a) => (a.id === id ? res.data : a)))
  }

  const searchReady = server.health?.search.configured ?? true

  return (
    <div className={collapsed ? 'app is-collapsed' : 'app'}>
      <div className="titlebar" />
      <Sidebar
        section={section}
        onSelect={setSection}
        agents={agents}
        onChat={chatWith}
        onGroup={openGroup}
        onNewGroup={() => setGroupDialog({ id: null })}
        collapsed={collapsed}
        onToggle={toggleSidebar}
      />
      <main className={flush ? 'content is-flush' : 'content'}>
        {section === 'Home' && (
          <Home
            agents={agents}
            runnable={runnable}
            onBrowse={() => setSection('Agents')}
            onCode={() => setSection('Coder')}
            onStart={(agentId, text) => void start(agentId, text)}
          />
        )}
        {section === 'Coder' && <Coder agent={agents.find((a) => a.id === 'coder')} />}
        {section === 'Design' && <Design agents={agents} server={server} />}
        {section === 'Research' && <Research agents={agents} searchReady={searchReady} />}
        {section === 'Review' && (
          <Review agents={agents} onConnect={() => setSection('Integrations')} />
        )}
        {section === 'Chat' && (
          <Chat agents={agents} server={server} onEdit={build} onCreate={() => build(null)} />
        )}
        {section === 'Group' && (
          <Group
            agents={agents}
            onEdit={(id) => setGroupDialog({ id })}
            onCreate={() => setGroupDialog({ id: null })}
          />
        )}
        {section === 'Agents' && (
          <Agents
            agents={agents}
            server={server}
            openable={runnable}
            onOpen={openAgent}
            onBuild={build}
            onTeam={(id, teammates) => void setTeam(id, teammates)}
            onOpenGroup={openGroup}
            onEditGroup={(id) => setGroupDialog({ id })}
          />
        )}
        {section === 'Builder' && (
          <Builder
            key={editing ?? 'new'}
            agentId={editing}
            server={server}
            onClose={() => setSection('Agents')}
            onSaved={(agent) => {
              // The chat store learns of a new agent now, not a render later.
              const chat = useChat.getState()
              chat.setAgentIds([...new Set([...chat.agentIds, agent.id])])
              // A new agent opens ready to talk; an edited one where it was left.
              if (editing === null) newChat(agent.id)
              else chatWith(agent.id)
              setSection('Chat')
              void refresh()
            }}
            onDeleted={() => {
              void refresh()
              setSection('Agents')
            }}
            onConnectApps={() => setSection('Integrations')}
          />
        )}
        {section === 'Computers' && <Computers agents={agents} server={server} />}
        {section === 'Integrations' && <Integrations agents={agents} />}
        {section === 'Routines' && (
          <Routines
            agents={agents}
            groups={groups}
            onOpenSession={(session) => {
              if (session.group_id) {
                openGroup(session.group_id)
                void useGroupChat.getState().open(session.id)
              } else {
                const home = byId.get(session.agent_id)
                const where = home && homeOf(home)
                if (where === 'Chat') {
                  setSection('Chat')
                  void useChat.getState().open(session.id)
                } else if (where === 'Research') {
                  setSection('Research')
                  void useResearch.getState().open(session.id)
                }
              }
            }}
          />
        )}
        {section === 'Settings' && (
          <Settings server={server} agents={agents} onRecheck={refresh} />
        )}
      </main>
      {groupDialog && (
        <GroupDialog
          key={groupDialog.id ?? 'new'}
          group={groups.find((g) => g.id === groupDialog.id) ?? null}
          onClose={() => setGroupDialog(null)}
          onSaved={(group) => {
            const made = groupDialog.id === null
            setGroupDialog(null)
            // A new group opens ready to talk; a changed one stays where the user is.
            if (made) openGroup(group.id, true)
          }}
          onDeleted={() => {
            setGroupDialog(null)
            if (section === 'Group') setSection('Agents')
          }}
        />
      )}
    </div>
  )
}
