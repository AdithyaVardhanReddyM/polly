import { CircleAlert, History, Layers, SquarePen, Trash2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { shortTime } from '../coder/toolMeta'
import { activity, TranscriptView } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Splitter, usePaneShare } from '../components/Splitter'
import { Canvas } from '../design/Canvas'
import { Inspector, useInspecting } from '../design/Inspector'
import { LeftPanel } from '../design/Layers'
import { clamp } from '../design/model'
import { useDesign } from '../design/session'
import { useCanvas } from '../design/store'
import { Toolbar } from '../design/Toolbar'
import { AgentComposer } from '../research/AgentComposer'

/** The chat's share of the workspace until the user drags the divider: a third. */
const CHAT_SHARE = 1 / 3
const CHAT_MIN = 320
/** The canvas never gets narrower than this while the chat is dragged wider. */
const STAGE_MIN = 480
/** Room the floating panels take from the canvas, kept clear when zooming to fit. */
const LEFT_PANEL = 240 + 16
const RIGHT_PANEL = 256 + 16
const LAYERS_KEY = 'polly.design.layers'

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function recallFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

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
  const saveState = useCanvas((s) => s.saveState)
  const saving = useCanvas((s) => s.sessionId)
  const inspecting = useInspecting()
  const [share, setShare, resetShare] = usePaneShare('polly.pane.design-chat-share', CHAT_SHARE)
  const root = useRef<HTMLDivElement>(null)
  const [rootW, setRootW] = useState(0)
  const [layers, setLayers] = useState(() => recallFlag(LAYERS_KEY))
  const [history, setHistory] = useState(false)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = (): void => setRootW(el.getBoundingClientRect().width)
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  const chatMax = Math.max(CHAT_MIN, rootW - STAGE_MIN)
  const chatW = Math.round(clamp(rootW * share, CHAT_MIN, chatMax))

  useEffect(() => {
    void boot()
  }, [boot])

  useEffect(() => {
    useCanvas.getState().setInsets({ left: layers ? LEFT_PANEL : 0, right: inspecting ? RIGHT_PANEL : 0 })
  }, [layers, inspecting])

  const toggleLayers = (open: boolean): void => {
    setLayers(open)
    try {
      localStorage.setItem(LAYERS_KEY, open ? '1' : '0')
    } catch {
      /* storage can be unavailable */
    }
  }

  const agent = agents.find((a) => a.id === 'designer')
  const modelReady = server.health?.model.configured ?? true
  const hero = items.length === 0

  // When the first message goes out, the box glides from the centre to its
  // place at the bottom: note where it was, then animate from there (FLIP).
  const stage = useRef<HTMLDivElement>(null)
  const from = useRef<DOMRect | null>(null)
  useLayoutEffect(() => {
    const box = stage.current?.querySelector<HTMLElement>('.composer-box')
    if (hero) {
      from.current = box?.getBoundingClientRect() ?? null
      return
    }
    const start = from.current
    from.current = null
    if (!start || !box || reducedMotion()) return
    const end = box.getBoundingClientRect()
    const dy = start.top - end.top
    if (Math.abs(dy) < 2) return
    box.animate(
      [{ transform: `translate(${start.left - end.left}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
  })

  return (
    <div
      className="design"
      ref={root}
      style={{ '--design-chat-w': `${chatW}px` } as React.CSSProperties}
    >
      <section className={hero ? 'chat design-chat is-empty' : 'chat design-chat'}>
        <header className="chat-head">
          {agent && <AgentAvatar agent={agent} size={24} active={run === 'running'} />}
          <div className="chat-title">
            <b>{session?.title || (saving ? 'Untitled design' : 'New design')}</b>
            {saving && (
              <span className={`dz-save is-${saveState}`}>
                {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}
              </span>
            )}
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

        {!hero && <TranscriptView items={items} run={run} agent={agent} />}

        <div className="composer-stage" ref={stage}>
          {hero && (
            <div className="hero">
              {agent && (
                <div className="hero-bot" aria-hidden>
                  <AgentAvatar agent={agent} size={88} bare motion="medium" />
                  <span className="hero-bot-shadow" />
                </div>
              )}
              <h2>What should we design?</h2>
            </div>
          )}
          <AgentComposer
            store={useDesign}
            disabled={!modelReady}
            placeholder={hero ? 'Describe what you want designed…' : 'Ask for a change, or a new frame…'}
            defaultModel={agent?.model ?? ''}
          />
        </div>
      </section>

      <Splitter
        side="left"
        width={chatW}
        min={CHAT_MIN}
        max={chatMax}
        onResize={(w) => rootW && setShare(w / rootW)}
        onReset={resetShare}
        yields=":scope > .design-stage"
        yieldsMin={STAGE_MIN}
      />

      <section className="design-stage">
        <Canvas sessionId={sessionId} />
        {layers ? (
          <aside className="dz-panel is-left">
            <LeftPanel onClose={() => toggleLayers(false)} />
          </aside>
        ) : (
          <button className="dz-chip is-layers" title="Show layers" onClick={() => toggleLayers(true)}>
            <Layers />
            <span>Layers</span>
          </button>
        )}
        {run === 'running' && agent && (
          <div className="dz-status" role="status">
            <AgentAvatar agent={agent} size={20} bare motion="fast" />
            <span className="shimmer">{canvasActivity(activity(items, (ref) => ref))}</span>
          </div>
        )}
        {inspecting && (
          <aside className="dz-panel is-right">
            <Inspector />
          </aside>
        )}
        <Toolbar />
      </section>
    </div>
  )
}

/** The Designer's current step, as the canvas puts it. */
function canvasActivity(label: string): string {
  if (label === 'Thinking') return 'Thinking about the design'
  if (label === 'Writing') return 'Writing to you'
  return label
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
