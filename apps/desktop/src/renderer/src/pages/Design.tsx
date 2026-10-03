import {
  CircleAlert,
  History,
  PanelLeft,
  PanelRight,
  PenTool,
  SquarePen,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { api } from '../api'
import type { ServerState } from '../App'
import { shortTime } from '../coder/toolMeta'
import { TranscriptView } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Splitter, usePaneWidth } from '../components/Splitter'
import { Canvas } from '../design/Canvas'
import { Inspector } from '../design/Inspector'
import { LeftPanel } from '../design/Layers'
import { useDesign } from '../design/session'
import { useCanvas } from '../design/store'
import { Toolbar } from '../design/Toolbar'
import { AgentComposer } from '../research/AgentComposer'

const STARTERS = [
  'A mobile banking home screen: balance, a card, quick actions and recent activity',
  'A bold launch poster for a coffee brand called Slow Morning, 1080×1350',
  'A SaaS analytics dashboard with a sidebar, KPI cards and a revenue chart',
  'A landing page hero and pricing section for a note-taking app'
]

export function Design({
  agents,
  server
}: {
  agents: AgentSummary[]
  server: ServerState
}): React.JSX.Element {
  const boot = useDesign((s) => s.boot)
  const session = useDesign((s) => s.session)
  const sessionId = useDesign((s) => s.sessionId)
  const items = useDesign((s) => s.items)
  const run = useDesign((s) => s.run)
  const error = useDesign((s) => s.error)
  const clearError = useDesign((s) => s.clearError)
  const send = useDesign((s) => s.send)
  const saveState = useCanvas((s) => s.saveState)
  const [chatW, setChatW, resetChat] = usePaneWidth('polly.pane.design-chat', 380)
  const [left, setLeft] = useState(true)
  const [right, setRight] = useState(true)
  const [history, setHistory] = useState(false)

  useEffect(() => {
    void boot()
  }, [boot])

  const agent = agents.find((a) => a.id === 'designer')
  const modelReady = server.health?.model.configured ?? true
  const blank = async (): Promise<void> => {
    const created = await api.sessions.create({ agent_id: 'designer', title: 'Untitled design' })
    if (!created.ok) return
    await useDesign.getState().refresh()
    await useDesign.getState().open(created.data.id)
  }

  return (
    <div className="design" style={{ '--design-chat-w': `${chatW}px` } as React.CSSProperties}>
      <section className="chat design-chat">
        <header className="chat-head">
          {agent && <AgentAvatar agent={agent} size={24} active={run === 'running'} />}
          <div className="chat-title">
            <b>{session?.title || 'New design'}</b>
          </div>
          <span className={`run-state is-${run}`}>{run === 'running' ? 'Designing' : ''}</span>
          <button className="icon-btn" title="Your designs" onClick={() => setHistory(!history)}>
            <History />
          </button>
          <button
            className="icon-btn"
            title="New design"
            onClick={() => useDesign.getState().newSession()}
          >
            <SquarePen />
          </button>
          {history && <DesignHistory onClose={() => setHistory(false)} />}
        </header>

        {!modelReady && (
          <div className="banner is-warn">
            <TriangleAlert />
            <span>
              The Designer needs a model. Add <code>NEBIUS_API_KEY</code> to <code>.env</code> and
              restart the server. You can still design by hand.
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

        {items.length === 0 ? (
          <div className="coder-starters design-start">
            <div className="welcome-mark is-design">
              <PenTool />
            </div>
            <h2>
              What should we <em>design?</em>
            </h2>
            <p className="research-blurb">
              Screens, posters and graphics on a canvas you can edit by hand, then export as HTML,
              Tailwind or React.
            </p>
            <div className="starter-grid">
              {STARTERS.map((s) => (
                <button key={s} className="starter" disabled={!modelReady} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <TranscriptView items={items} run={run} agent={agent} />
        )}

        <AgentComposer
          store={useDesign}
          disabled={!modelReady}
          placeholder={sessionId ? 'Ask for a change, or a new frame…' : 'Describe what you want designed…'}
        />
      </section>

      <Splitter
        side="left"
        width={chatW}
        min={320}
        max={720}
        onResize={setChatW}
        onReset={resetChat}
        yields=":scope > .design-stage"
        yieldsMin={520}
      />

      <section className="design-stage">
        {left && sessionId && <LeftPanel />}
        <div className="design-canvas">
          <Canvas sessionId={sessionId} />
          <div className="dz-corner is-left">
            <button
              className={`dz-chip${left ? ' is-active' : ''}`}
              title="Layers and components"
              onClick={() => setLeft(!left)}
            >
              <PanelLeft />
            </button>
          </div>
          <div className="dz-corner is-right">
            {sessionId && (
              <span className={`dz-save is-${saveState}`}>
                {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}
              </span>
            )}
            <button
              className={`dz-chip${right ? ' is-active' : ''}`}
              title="Edit panel"
              onClick={() => setRight(!right)}
            >
              <PanelRight />
            </button>
          </div>
          {sessionId ? (
            <Toolbar />
          ) : (
            <div className="dz-empty">
              <PenTool />
              <b>An empty canvas</b>
              <span>Describe a design in the chat, or start drawing yourself.</span>
              <button className="btn" onClick={() => void blank()}>
                Start with a blank canvas
              </button>
            </div>
          )}
        </div>
        {right && sessionId && (
          <aside className="dz-right">
            <Inspector />
          </aside>
        )}
      </section>
    </div>
  )
}

function DesignHistory({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sessions = useDesign((s) => s.sessions)
  const sessionId = useDesign((s) => s.sessionId)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!panel.current?.contains(e.target as Node)) onClose()
    }
    const timer = setTimeout(() => window.addEventListener('pointerdown', onDown), 0)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  return (
    <div className="design-history" ref={panel}>
      <h5>Your designs</h5>
      {sessions.length === 0 && <p className="dz-note">Nothing designed yet.</p>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`design-history-row${s.id === sessionId ? ' is-active' : ''}`}
          onClick={() => {
            void useDesign.getState().open(s.id)
            onClose()
          }}
        >
          <span className={`session-dot is-${s.status}`} />
          <span className="design-history-title">{s.title || 'Untitled design'}</span>
          <em>{shortTime(s.updated_at)}</em>
          <button
            className="icon-btn"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm('Delete this design?')) void useDesign.getState().remove(s.id)
            }}
          >
            <Trash2 />
          </button>
        </div>
      ))}
    </div>
  )
}
