import { useCallback, useEffect, useState } from 'react'
import type { AgentSummary, ServerHealth } from '../../shared/contracts'
import { api } from './api'
import { HOME_OF, SECTIONS, Sidebar, type Section, useSidebarCollapsed } from './components/Sidebar'
import { Agents } from './pages/Agents'
import { Coder } from './pages/Coder'
import { Computers } from './pages/Computers'
import { Design } from './pages/Design'
import { Home } from './pages/Home'
import { Integrations } from './pages/Integrations'
import { Research } from './pages/Research'
import { PR_URL, Review } from './pages/Review'
import { Settings } from './pages/Settings'
import { useDesign } from './design/session'
import { useResearch, useReview } from './store/agentSession'
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

  const flush = section === 'Coder' || section === 'Design' || section === 'Research' || section === 'Review'

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
    setSection('Research')
    const research = useResearch.getState()
    research.newSession()
    research.setAgent(target)
    await research.send(text)
  }

  const openAgent = (id: string): void => {
    const home = HOME_OF[id]
    if (!home) return
    if (id === 'designer') useDesign.getState().newSession()
    if (id === 'researcher' || id === 'deep-research') {
      useResearch.getState().newSession()
      useResearch.getState().setAgent(id)
    }
    setSection(home)
  }

  /** From the sidebar: back to the agent's workspace as it was left. */
  const chatWith = (id: string): void => {
    const home = HOME_OF[id]
    if (!home) return
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
            runnable={Object.keys(HOME_OF)}
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
        {section === 'Agents' && (
          <Agents agents={agents} server={server} openable={Object.keys(HOME_OF)} onOpen={openAgent} />
        )}
        {section === 'Computers' && <Computers agents={agents} server={server} />}
        {section === 'Integrations' && <Integrations agents={agents} />}
        {section === 'Settings' && <Settings server={server} onRecheck={refresh} />}
      </main>
    </div>
  )
}
