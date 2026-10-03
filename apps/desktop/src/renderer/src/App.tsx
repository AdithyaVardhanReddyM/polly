import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentSummary, ServerHealth } from '../../shared/contracts'
import { api } from './api'
import { homeOf, SECTIONS, Sidebar, type Section, useSidebarCollapsed } from './components/Sidebar'
import { Agents } from './pages/Agents'
import { Builder } from './pages/Builder'
import { Chat } from './pages/Chat'
import { Coder } from './pages/Coder'
import { Computers } from './pages/Computers'
import { Design } from './pages/Design'
import { Home } from './pages/Home'
import { Integrations } from './pages/Integrations'
import { Research } from './pages/Research'
import { PR_URL, Review } from './pages/Review'
import { Settings } from './pages/Settings'
import { useDesign } from './design/session'
import { useChat, useResearch, useReview } from './store/agentSession'
import { useCoder } from './store/coder'

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

  const refresh = useCallback(async () => {
    setServer((s) => ({ ...s, checking: true }))
    const [health, catalog] = await Promise.all([api.health(), api.agents()])
    setServer({
      health: health.ok ? health.data : null,
      error: health.ok ? null : health.error,
      checking: false
    })
    if (catalog.ok) setAgents(catalog.data)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const current = window.location.hash.slice(1).split('/')[0].toLowerCase()
    if (current !== section.toLowerCase()) {
      window.history.replaceState(null, '', `#${section.toLowerCase()}`)
    }
  }, [section])

  // The chat workspace covers whichever agents the user has made.
  useEffect(() => {
    useChat.getState().setAgentIds(agents.filter((a) => a.custom).map((a) => a.id))
  }, [agents])

  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const runnable = useMemo(
    () => agents.filter((a) => a.status === 'ready' && homeOf(a)).map((a) => a.id),
    [agents]
  )

  const flush = ['Coder', 'Design', 'Research', 'Review', 'Chat', 'Builder'].includes(section)

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
    if (byId.get(target)?.custom) {
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

  const searchReady = server.health?.search.configured ?? true

  return (
    <div className={collapsed ? 'app is-collapsed' : 'app'}>
      <div className="titlebar" />
      <Sidebar
        section={section}
        onSelect={setSection}
        agents={agents}
        onChat={chatWith}
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
        {section === 'Agents' && (
          <Agents
            agents={agents}
            server={server}
            openable={runnable}
            onOpen={openAgent}
            onBuild={build}
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
        {section === 'Settings' && (
          <Settings server={server} agents={agents} onRecheck={refresh} />
        )}
      </main>
    </div>
  )
}
