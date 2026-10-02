import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentStore } from '../store/agentSession'

/** Message box for project-less agents. `children` sit left of the send button. */
export function AgentComposer({
  store,
  placeholder,
  disabled = false,
  children
}: {
  store: AgentStore
  placeholder: string
  disabled?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const run = store((s) => s.run)
  const send = store((s) => s.send)
  const cancel = store((s) => s.cancel)
  const [draft, setDraft] = useState('')
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

  const submit = (): void => {
    if (disabled || busy || !draft.trim()) return
    const text = draft
    setDraft('')
    void send(text)
  }

  return (
    <div className="coder-composer">
      <div className={`composer-box${busy ? ' is-busy' : ''}`}>
        <textarea
          ref={area}
          rows={1}
          value={draft}
          placeholder={busy ? 'Working…' : placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
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
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
