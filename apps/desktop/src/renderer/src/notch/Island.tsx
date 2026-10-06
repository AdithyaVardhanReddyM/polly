import {
  ArrowUp,
  BookOpen,
  Check,
  CircleCheck,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Settings,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AgentAvatar } from '../components/AgentAvatar'
import { Notices, ReminderCard, SuggestionCard, TodoCard } from './Cards'
import {
  ask,
  attach,
  clearThread,
  hideWindow,
  refreshBases,
  runChip,
  stop,
  toggleWatching
} from './controller'
import { useNotch } from './store'

const bridge = window.polly?.copilot

// The island's window is this wide; the island is centred in it, under the notch.
const WINDOW_WIDTH = 760
const WING = 42
const EXPANDED_WIDTH = 640
const MAX_HEIGHT = 620

const POLLY = { avatar: { seed: 'Polly' }, division: 'custom' as const, name: 'Polly' }

type Mode = 'hidden' | 'compact' | 'peek' | 'expanded'

export function Island(): React.JSX.Element {
  const copilot = useNotch((s) => s.copilot)
  const hovering = useNotch((s) => s.hovering)
  const pinned = useNotch((s) => s.pinned)
  const typing = useNotch((s) => s.typing)
  const peek = useNotch((s) => s.peek)
  const card = useNotch((s) => s.card)
  const proposals = useNotch((s) => s.proposals)
  const reminders = useNotch((s) => s.reminders)
  const busy = useNotch((s) => s.busy)
  const set = useNotch((s) => s.set)

  const geometry = copilot?.geometry
  const notchWidth = geometry?.notch?.width ?? 0
  const notchHeight = geometry?.notch?.height ?? geometry?.menuBarHeight ?? 32
  const watching = Boolean(copilot?.watching)

  // Hovering opens the island after a beat; leaving closes it after a longer one.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const keep = hovering || pinned || typing
    const timer = setTimeout(() => setOpen(keep), keep ? 110 : 420)
    return () => clearTimeout(timer)
  }, [hovering, pinned, typing])

  const pending = Boolean(card && card.proactive) || proposals.length > 0 || reminders.length > 0
  const mode: Mode = open
    ? 'expanded'
    : peek
      ? 'peek'
      : watching || pending
        ? 'compact'
        : 'hidden'

  // The island grows to fit its content (up to MAX_HEIGHT, then the body scrolls).
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [bodyHeight, setBodyHeight] = useState(0)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => setBodyHeight(el.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [mode])

  const compactWidth = Math.max(notchWidth, 120) + WING * 2
  const size =
    mode === 'expanded'
      ? { width: EXPANDED_WIDTH, height: Math.min(MAX_HEIGHT, notchHeight + bodyHeight) }
      : mode === 'peek'
        ? { width: Math.max(compactWidth, 360), height: notchHeight + 34 }
        : mode === 'compact'
          ? { width: compactWidth, height: notchHeight }
          : { width: Math.max(notchWidth, 120), height: notchHeight }

  // Tell the main process which part of the window takes the mouse.
  useEffect(() => {
    const x = (WINDOW_WIDTH - size.width) / 2
    if (mode === 'hidden') {
      // Invisible, but hovering the notch still opens it.
      const width = notchWidth || 200
      const height = notchWidth ? notchHeight : 6
      bridge?.setIslandRect({ x: (WINDOW_WIDTH - width) / 2, y: 0, width, height })
    } else {
      bridge?.setIslandRect({ x: x - 8, y: 0, width: size.width + 16, height: size.height + 6 })
    }
  }, [mode, size.width, size.height, notchWidth, notchHeight])

  useEffect(() => {
    if (mode !== 'expanded') bridge?.setIslandFocusable(false)
  }, [mode])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        set({ pinned: false, typing: false })
        ;(document.activeElement as HTMLElement | null)?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [set])

  const thinking = Boolean(busy) || Boolean(card && !card.done)
  const motion = thinking ? 'fast' : watching ? 'slow' : 'none'

  return (
    <div
      className={`island ${mode}${watching ? ' watching' : ''}`}
      style={{
        width: size.width,
        height: size.height,
        ['--notch-h' as string]: `${notchHeight}px`,
        ['--notch-w' as string]: `${notchWidth}px`
      }}
    >
      <div className="island-top" style={{ height: notchHeight }}>
        <div className="wing left">
          <span className={`avatar${watching ? '' : ' off'}`}>
            <AgentAvatar agent={POLLY} size={mode === 'expanded' ? 22 : 20} bare motion={motion} />
          </span>
          {mode === 'expanded' && <ContextChip />}
        </div>
        <div className="wing right">
          {mode === 'expanded' ? <HeaderActions /> : <WingStatus thinking={thinking} />}
        </div>
      </div>

      {mode === 'peek' && peek && (
        <div className={`island-peek tone-${peek.tone}`}>
          {peek.tone === 'hint' && <Sparkles size={13} />}
          {peek.tone === 'todo' && <CircleCheck size={13} />}
          <span>{peek.text}</span>
        </div>
      )}

      {mode === 'expanded' && (
        <div className="island-body" ref={scrollRef}>
          <div className="island-content" ref={bodyRef}>
            <Panel scrollRef={scrollRef} />
          </div>
        </div>
      )}
    </div>
  )
}

function WingStatus({ thinking }: { thinking: boolean }): React.JSX.Element {
  const copilot = useNotch((s) => s.copilot)
  const card = useNotch((s) => s.card)
  const proposals = useNotch((s) => s.proposals)
  const reminders = useNotch((s) => s.reminders)
  const count = proposals.length + reminders.length
  if (count > 0) return <span className="badge">{count}</span>
  if (card?.proactive && card.done) return <span className="dot hint" />
  if (thinking) return <span className="dot thinking" />
  if (!copilot?.watching) return <span className="off-label">Off</span>
  return <span className="dot live" />
}

function ContextChip(): React.JSX.Element | null {
  const context = useNotch((s) => s.context)
  const icon = useNotch((s) => s.appIcon)
  const excluded = useNotch((s) => s.excluded)
  const watching = useNotch((s) => s.copilot?.watching)
  if (!watching) return <span className="context-chip muted">Not watching</span>
  if (excluded) return <span className="context-chip muted">{excluded.app} · hidden</span>
  if (!context) return <span className="context-chip muted">Polly</span>
  return (
    <span className="context-chip" title={context.label}>
      {icon && <img src={`data:image/png;base64,${icon}`} alt="" />}
      <span>{context.label}</span>
    </span>
  )
}

function HeaderActions(): React.JSX.Element {
  const copilot = useNotch((s) => s.copilot)
  const pinned = useNotch((s) => s.pinned)
  const set = useNotch((s) => s.set)
  const watching = Boolean(copilot?.watching)
  return (
    <div className="header-actions">
      <button
        className={`n-icon${watching ? ' on' : ''}`}
        title={watching ? `Stop watching (${copilot?.shortcut})` : `Start watching (${copilot?.shortcut})`}
        onClick={toggleWatching}
      >
        {watching ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <button
        className={`n-icon${pinned ? ' on' : ''}`}
        title={pinned ? 'Unpin' : 'Keep open'}
        onClick={() => set({ pinned: !pinned })}
      >
        {pinned ? <PinOff size={15} /> : <Pin size={15} />}
      </button>
      <button className="n-icon" title="Copilot settings" onClick={() => void bridge?.openMain('settings')}>
        <Settings size={15} />
      </button>
    </div>
  )
}

function Panel({
  scrollRef
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const copilot = useNotch((s) => s.copilot)
  const context = useNotch((s) => s.context)
  const chips = useNotch((s) => s.chips)
  const card = useNotch((s) => s.card)
  const thread = useNotch((s) => s.thread)
  const proposals = useNotch((s) => s.proposals)
  const reminders = useNotch((s) => s.reminders)
  const busy = useNotch((s) => s.busy)
  const excluded = useNotch((s) => s.excluded)
  const lastSnapshot = useNotch((s) => s.lastSnapshot)
  const watching = Boolean(copilot?.watching)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [thread, scrollRef])

  const showChips = watching && !excluded && chips.length > 0
  const nothing =
    !card && thread.length === 0 && proposals.length === 0 && reminders.length === 0

  return (
    <>
      <Ask />

      {showChips && (
        <div className="chips">
          {chips.map((chip) => (
            <button key={chip.id} className="chip" onClick={() => void runChip(chip)}>
              {chip.agentic && <Sparkles size={12} />}
              {chip.label}
            </button>
          ))}
          {lastSnapshot && !lastSnapshot.excluded && (
            <button className="chip quiet" title="Polly stops looking at this window" onClick={() => void hideWindow()}>
              <EyeOff size={12} />
              Hide this window
            </button>
          )}
        </div>
      )}

      <div className="cards">
        <Notices />

        {reminders.map((todo) => (
          <ReminderCard key={todo.id} todo={todo} />
        ))}

        {thread.length > 0 ? (
          <div className="thread">
            <div className="thread-head">
              <span>Conversation</span>
              <button className="n-icon" title="Clear" onClick={clearThread}>
                <X size={14} />
              </button>
            </div>
            {card?.proactive && <SuggestionCard card={card} />}
            {thread.map((turn, i) =>
              turn.role === 'user' ? (
                <div key={i} className="turn-user">
                  {turn.text}
                </div>
              ) : turn.card ? (
                <SuggestionCard key={turn.card.id} card={turn.card} inline />
              ) : null
            )}
          </div>
        ) : (
          card && <SuggestionCard card={card} />
        )}

        {proposals.map((todo) => (
          <TodoCard key={todo.id} todo={todo} />
        ))}

        {nothing && (
          <div className="empty">
            {!watching ? (
              <>
                <span>Polly isn&apos;t watching your screen.</span>
                <button className="n-btn primary" onClick={toggleWatching}>
                  Start watching
                  <kbd>{copilot?.shortcut}</kbd>
                </button>
              </>
            ) : busy ? (
              <span className="n-faint">{busy}</span>
            ) : excluded ? null : context ? (
              <span className="n-faint">Pick an action, or ask about what&apos;s on screen.</span>
            ) : (
              <span className="n-faint">Switch to a window and Polly will take a look.</span>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function Ask(): React.JSX.Element {
  const [text, setText] = useState('')
  const [menu, setMenu] = useState(false)
  const bases = useNotch((s) => s.bases)
  const attached = useNotch((s) => s.attached)
  const thread = useNotch((s) => s.thread)
  const set = useNotch((s) => s.set)
  const streaming = thread.some((t) => t.card && !t.card.done)
  const watching = useNotch((s) => s.copilot?.watching)

  const send = (): void => {
    if (!text.trim()) return
    void ask(text)
    setText('')
  }

  return (
    <div className="ask">
      <div className="ask-field">
        {attached.map((id) => {
          const base = bases.find((b) => b.id === id)
          return base ? (
            <span key={id} className="kb-chip">
              <BookOpen size={12} />
              {base.name}
              <button onClick={() => attach(id)} title="Detach">
                <X size={11} />
              </button>
            </span>
          ) : null
        })}
        <input
          value={text}
          placeholder={
            attached.length
              ? 'Ask your knowledge files…'
              : watching
                ? 'Ask about this, or find something you saw…'
                : 'Ask Polly…'
          }
          onChange={(e) => setText(e.target.value)}
          onFocus={() => set({ typing: true })}
          onBlur={() => set({ typing: false })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className={`n-icon${menu ? ' on' : ''}`}
          title="Knowledge"
          onClick={() => {
            if (!menu) void refreshBases()
            setMenu(!menu)
          }}
        >
          <BookOpen size={15} />
        </button>
        {streaming ? (
          <button className="send stop" title="Stop" onClick={stop}>
            <Square size={11} />
          </button>
        ) : (
          <button className="send" title="Ask" disabled={!text.trim()} onClick={send}>
            <ArrowUp size={15} />
          </button>
        )}
      </div>
      {menu && (
        <div className="kb-menu">
          {bases.length === 0 && <div className="kb-empty">No knowledge bases yet.</div>}
          {bases.map((base) => (
            <button key={base.id} className="kb-row" onClick={() => attach(base.id)}>
              <BookOpen size={14} />
              <span>{base.name}</span>
              <span className="n-faint">{base.files} files</span>
              {attached.includes(base.id) && <Check size={14} />}
            </button>
          ))}
          <button
            className="kb-row manage"
            onClick={() => {
              setMenu(false)
              void bridge?.openMain('knowledge')
            }}
          >
            Manage knowledge…
          </button>
        </div>
      )}
    </div>
  )
}
