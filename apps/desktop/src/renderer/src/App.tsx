import { useCallback, useEffect, useState } from 'react'
import type { AgentSummary, ServerHealth } from '../../shared/contracts'
import { api } from './api'
import { SECTIONS, Sidebar, type Section } from './components/Sidebar'
import { Agents } from './pages/Agents'
import { Coder } from './pages/Coder'
import { Computers } from './pages/Computers'
import { Home } from './pages/Home'
import { Integrations } from './pages/Integrations'
import { Settings } from './pages/Settings'

export interface ServerState {
  health: ServerHealth | null
  error: string | null
  checking: boolean
}

const ALL_SECTIONS: readonly Section[] = [...SECTIONS, 'Settings']

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

  const flush = section === 'Coder'

  return (
    <div className="app">
      <div className="titlebar" />
      <Sidebar section={section} onSelect={setSection} server={server} onRecheck={refresh} />
      <main className={flush ? 'content is-flush' : 'content'}>
        {section === 'Home' && (
          <Home
            agents={agents}
            onBrowse={() => setSection('Agents')}
            onCode={() => setSection('Coder')}
          />
        )}
        {section === 'Coder' && <Coder agent={agents.find((a) => a.id === 'coder')} />}
        {section === 'Agents' && (
          <Agents agents={agents} server={server} onOpen={(id) => id === 'coder' && setSection('Coder')} />
        )}
        {section === 'Computers' && <Computers agents={agents} server={server} />}
        {section === 'Integrations' && <Integrations />}
        {section === 'Settings' && <Settings server={server} onRecheck={refresh} />}
      </main>
    </div>
  )
}
