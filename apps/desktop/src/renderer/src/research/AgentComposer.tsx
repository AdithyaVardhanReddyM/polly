import { ArrowUp, AtSign, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { ModelChip, ModelMenu, Popover } from '../coder/Composer'
import { AgentAvatar } from '../components/AgentAvatar'
import { SendArt } from '../components/StageArt'
import type { AgentStore } from '../store/agentSession'
import { useModels } from '../store/models'

/** The `@…` being typed just before the caret: where it starts and what follows it. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const found = /(?:^|\s)@([^@\n]{0,40})$/.exec(text.slice(0, caret))
  if (!found) return null
  return { start: caret - found[1].length - 1, query: found[1].toLowerCase() }
}

/** Names can have spaces ("Deep Research"), so a query matches from the start of a name. */
function matching(agents: AgentSummary[], query: string): AgentSummary[] {
  if (!query) return agents
  const starts = agents.filter((a) => a.name.toLowerCase().startsWith(query))
  if (query.includes(' ')) return starts
  const within = agents.filter(
    (a) => !starts.includes(a) && a.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(query))
  )
  return [...starts, ...within]
}

/** The agents whose `@Name` is in the text. */
function mentioned(text: string, agents: AgentSummary[]): string[] {
  const lower = text.toLowerCase()
  return agents
    .filter((a) => {
      const at = lower.indexOf(`@${a.name.toLowerCase()}`)
      if (at < 0) return false
      const after = lower[at + a.name.length + 1]
      return after === undefined || !/[\w-]/.test(after)
    })
    .map((a) => a.id)
}

/**
 * Message box for project-less agents. `children` sit left of the send
 * button. With `mentionable`, typing `@` offers those agents; the ones named
 * in a message are sent along with it.
 */
export function AgentComposer({
  store,
  placeholder,
  disabled = false,
  mentionable = [],
  defaultModel,
  children
}: {
  store: AgentStore
  placeholder: string
  disabled?: boolean
  /** Agents the user can address with `@Name`. */
  mentionable?: AgentSummary[]
  /**
   * The agent's own model. Given, the box offers the model and, for models
   * that think, the reasoning effort.
   */
  defaultModel?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const run = store((s) => s.run)
  const send = store((s) => s.send)
  const cancel = store((s) => s.cancel)
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [cursor, setCursor] = useState(0)
  // The mention the user closed with Escape: it stays closed until they type another.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const busy = run !== 'idle'

  useEffect(() => {
    const el = area.current
    if (!el) return
    const fit = (): void => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }
    fit()
    // Re-fit when the column changes width (a pane dragged, the window resized).
    const obs = new ResizeObserver(fit)
    obs.observe(el.parentElement ?? el)
    return () => obs.disconnect()
  }, [draft])

  const mention = mentionable.length ? mentionAt(draft, caret) : null
  const options = mention && mention.start !== dismissed ? matching(mentionable, mention.query) : []
  const picking = options.length > 0
  const active = Math.min(cursor, options.length - 1)

  const submit = (): void => {
    if (disabled || busy || !draft.trim()) return
    const text = draft
    setDraft('')
    void send(text, mentioned(text, mentionable))
  }

  const pick = (agent: AgentSummary): void => {
    if (!mention) return
    const before = draft.slice(0, mention.start)
    const after = draft.slice(caret).replace(/^ /, '')
    const next = `${before}@${agent.name} ${after}`
    const at = before.length + agent.name.length + 2
    setDraft(next)
    setCaret(at)
    setCursor(0)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(at, at)
    })
  }

  /** The `@` button: start a mention where the caret is. */
  const startMention = (): void => {
    const el = area.current
    const at = el?.selectionStart ?? draft.length
    const gap = at > 0 && !/\s/.test(draft[at - 1]) ? ' ' : ''
    const next = `${draft.slice(0, at)}${gap}@${draft.slice(at)}`
    const pos = at + gap.length + 1
    setDraft(next)
    setCaret(pos)
    setDismissed(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="coder-composer">
      <div className={`composer-box${busy ? ' is-busy' : ''}`}>
        {picking && (
          <div className="menu mention-menu" role="listbox" aria-label="Mention an agent">
            {options.map((a, i) => (
              <button
                key={a.id}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'menu-item is-active' : 'menu-item'}
                // Keep the caret in the message while choosing.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(a)}
              >
                <AgentAvatar agent={a} size={26} />
                <span className="menu-text">
                  <b>{a.name}</b>
                  <span>{a.tagline}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={draft}
          placeholder={busy ? 'Working…' : placeholder}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value)
            setCaret(e.target.selectionStart)
            setCursor(0)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (picking && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setCursor((active + step + options.length) % options.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pick(options[active])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDismissed(mention?.start ?? null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          {mentionable.length > 0 && (
            <button
              className="icon-btn composer-at"
              title="Mention an agent"
              aria-label="Mention an agent"
              disabled={disabled}
              onClick={startMention}
            >
              <AtSign />
            </button>
          )}
          {defaultModel !== undefined && (
            <>
              <AgentModelPicker store={store} fallback={defaultModel} />
            </>
          )}
          {children}
          <span className="composer-spacer" />
          {run === 'running' ? (
            <button className="send is-stop" title="Stop" onClick={() => void cancel()}>
              <Square />
            </button>
          ) : (
            <button
              className="send"
              title="Send (Enter)"
              disabled={disabled || busy || !draft.trim()}
              onClick={submit}
            >
              <SendArt />
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The model chip for a project-less agent's message box: the open
 * conversation's model and reasoning effort, or the ones the next
 * conversation will start on.
 */
export function AgentModelPicker({
  store,
  fallback
}: {
  store: AgentStore
  /** The agent's own default, shown until something else is picked. */
  fallback: string
}): React.JSX.Element {
  const session = store((s) => s.session)
  const picked = store((s) => s.model)
  const pickedEffort = store((s) => s.effort)
  const run = store((s) => s.run)
  const setModel = store((s) => s.setModel)
  const setEffort = store((s) => s.setEffort)
  const models = useModels((s) => s.models)
  const load = useModels((s) => s.load)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void load()
  }, [load])

  const model = session?.model || picked || fallback
  const effort = session?.reasoning_effort ?? pickedEffort
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <ModelChip
          model={model}
          models={models}
          effort={effort}
          disabled={run !== 'idle'}
          onClick={() => setOpen(!open)}
        />
      }
    >
      <ModelMenu
        models={models}
        value={model}
        onPick={(id) => {
          setOpen(false)
          void setModel(id)
        }}
        effort={effort}
        onEffort={(e) => void setEffort(e)}
      />
    </Popover>
  )
}
