import { ArrowUp, Check, ChevronDown, Hand, Map as MapIcon, ShieldCheck, Square, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ModelOption, PermissionMode } from '../../../shared/contracts'
import { useCoder } from '../store/coder'
import { describeModel } from '../store/models'
import { ModelLogo, NebiusLogo } from './icons'
import { formatTokens } from './toolMeta'

export const MODES: {
  id: PermissionMode
  label: string
  icon: React.JSX.Element
  blurb: string
}[] = [
  {
    id: 'supervised',
    label: 'Supervised',
    icon: <Hand />,
    blurb: 'Asks before every edit and command.'
  },
  {
    id: 'trusted',
    label: 'Trusted',
    icon: <ShieldCheck />,
    blurb: 'Edits files freely; asks before commands and deletes.'
  },
  {
    id: 'autonomous',
    label: 'Autonomous',
    icon: <Zap />,
    blurb: 'Never asks. Your blocked-command list still applies.'
  },
  { id: 'plan', label: 'Plan', icon: <MapIcon />, blurb: 'Read-only. Explores and proposes a plan.' }
]

const AUTONOMOUS_OK = 'polly.coder.autonomous-ok'

export function Composer({
  above,
  below,
  onBeforeSend,
  placeholder
}: {
  /** Shown over the box's top edge (the new-session screen's pickers). */
  above?: React.ReactNode
  /** Shown under the box. */
  below?: React.ReactNode
  /** Called just before a message goes out, while the box is still in place. */
  onBeforeSend?: () => void
  placeholder?: string
} = {}): React.JSX.Element {
  const run = useCoder((s) => s.run)
  const send = useCoder((s) => s.send)
  const cancel = useCoder((s) => s.cancel)
  const projectId = useCoder((s) => s.projectId)
  const [draft, setDraft] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  const busy = run !== 'idle'
  const disabled = !projectId || busy

  // Grow with the text up to a limit.
  useEffect(() => {
    const el = area.current
    if (!el) return
    const fit = (): void => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`
    }
    fit()
    // Re-fit when the column changes width (a pane dragged, the window resized).
    const obs = new ResizeObserver(fit)
    obs.observe(el.parentElement ?? el)
    return () => obs.disconnect()
  }, [draft])

  useEffect(() => {
    if (run === 'idle') area.current?.focus()
  }, [run])

  const submit = (): void => {
    if (disabled || !draft.trim()) return
    const text = draft
    onBeforeSend?.()
    setDraft('')
    void send(text)
  }

  return (
    <div className="coder-composer">
      {above && <div className="composer-above">{above}</div>}
      <div className={`composer-box${busy ? ' is-busy' : ''}`}>
        <textarea
          ref={area}
          rows={1}
          value={draft}
          placeholder={
            !projectId
              ? 'Open a project folder to start'
              : run === 'awaiting_approval'
                ? 'Waiting for your decision above…'
                : run === 'running'
                  ? 'Coder is working…'
                  : (placeholder ?? 'Ask Coder to build, fix or explain something')
          }
          disabled={!projectId}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          <ModeSwitcher />
          <ModelPicker />
          <span className="composer-spacer" />
          <ContextMeter />
          {run === 'running' ? (
            <button className="send is-stop" title="Stop" onClick={() => void cancel()}>
              <Square />
            </button>
          ) : (
            <button
              className="send"
              title="Send (Enter)"
              disabled={disabled || !draft.trim()}
              onClick={submit}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      {below && <div className="composer-below">{below}</div>}
    </div>
  )
}

function useCurrent(): { mode: PermissionMode; model: string } {
  const session = useCoder((s) => s.session)
  const project = useCoder((s) => s.projects.find((p) => p.id === s.projectId))
  return {
    mode: session?.mode ?? project?.settings.default_mode ?? 'supervised',
    model: session?.model ?? project?.settings.default_model ?? ''
  }
}

function ModeSwitcher(): React.JSX.Element {
  const { mode } = useCurrent()
  const setMode = useCoder((s) => s.setMode)
  const run = useCoder((s) => s.run)
  const [open, setOpen] = useState(false)
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  const locked = run !== 'idle'

  const choose = (next: PermissionMode): void => {
    setOpen(false)
    if (next === 'autonomous') {
      let ok = false
      try {
        ok = localStorage.getItem(AUTONOMOUS_OK) === '1'
      } catch {
        /* ignore */
      }
      if (
        !ok &&
        !window.confirm(
          'Autonomous mode lets the Coder edit files and run commands in this project without asking. Continue?'
        )
      )
        return
      try {
        localStorage.setItem(AUTONOMOUS_OK, '1')
      } catch {
        /* ignore */
      }
    }
    void setMode(next)
  }

  // Shift+Tab cycles modes, like a gear shift.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.shiftKey || locked) return
      const target = e.target as HTMLElement | null
      if (target?.tagName !== 'TEXTAREA') return
      e.preventDefault()
      const i = MODES.findIndex((m) => m.id === mode)
      choose(MODES[(i + 1) % MODES.length].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          className={`chip mode-chip is-${mode}`}
          disabled={locked}
          title={`${current.blurb} (⇧Tab to switch)`}
          onClick={() => setOpen(!open)}
        >
          {current.icon}
          <span>{current.label}</span>
          <ChevronDown className="chip-chev" />
        </button>
      }
    >
      <div className="menu menu-modes">
        <div className="menu-label">Permissions</div>
        {MODES.map((m) => (
          <button
            key={m.id}
            className={m.id === mode ? 'menu-item is-active' : 'menu-item'}
            onClick={() => choose(m.id)}
          >
            <span className={`menu-icon mode-chip is-${m.id}`}>{m.icon}</span>
            <span className="menu-text">
              <b>{m.label}</b>
              <span>{m.blurb}</span>
            </span>
            {m.id === mode && <Check className="menu-check" />}
          </button>
        ))}
        <div className="menu-foot">
          <kbd className="keycap">⇧ Tab</kbd> cycles modes
        </div>
      </div>
    </Popover>
  )
}

function ModelPicker(): React.JSX.Element {
  const { model } = useCurrent()
  const models = useCoder((s) => s.models)
  const setModel = useCoder((s) => s.setModel)
  const run = useCoder((s) => s.run)
  const [open, setOpen] = useState(false)
  const [peek, setPeek] = useState<string | null>(null)
  const current = describeModel(model, models)
  const vendors = [...new Set(models.map((m) => m.vendor))]
  const fastest = Math.max(0, ...models.map((m) => m.tokens_per_second ?? 0))
  const shown = models.find((m) => m.id === peek) ?? models.find((m) => m.id === model)

  const toggle = (next: boolean): void => {
    setOpen(next)
    setPeek(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={toggle}
      trigger={
        <button
          className="chip model-chip"
          disabled={run !== 'idle'}
          title={model}
          onClick={() => toggle(!open)}
        >
          <ModelLogo vendor={current.vendor} model={model} size={15} />
          <span>{model ? current.label : 'Model'}</span>
          <ChevronDown className="chip-chev" />
        </button>
      }
    >
      <div className="model-picker">
        <div className="menu menu-models" onMouseLeave={() => setPeek(null)}>
          <div className="menu-head">
            <NebiusLogo /> Served by Nebius Token Factory
          </div>
          {vendors.map((v) => (
            <div key={v} className="menu-group">
              <div className="menu-label">{v}</div>
              {models
                .filter((m) => m.vendor === v)
                .map((m) => (
                  <button
                    key={m.id}
                    className={m.id === model ? 'menu-item is-active' : 'menu-item'}
                    onMouseEnter={() => setPeek(m.id)}
                    onFocus={() => setPeek(m.id)}
                    onClick={() => {
                      toggle(false)
                      void setModel(m.id)
                    }}
                  >
                    <ModelLogo vendor={m.vendor} model={m.id} size={26} />
                    <span className="menu-text">
                      <b>
                        {m.label}
                        {m.is_default && <em className="badge">Default</em>}
                      </b>
                      <span>
                        {m.tokens_per_second ? `${Math.round(m.tokens_per_second)} tok/s · ` : ''}
                        {formatTokens(m.context_window)} context
                      </span>
                    </span>
                    {m.id === model && <Check className="menu-check" />}
                  </button>
                ))}
            </div>
          ))}
        </div>
        {shown && <ModelCard model={shown} fastest={fastest} />}
      </div>
    </Popover>
  )
}

function formatPrice(usd: number | null): string {
  if (usd === null) return '—'
  return `$${usd.toFixed(2)}`
}

/** The facts that matter when choosing a model, beside the picker list. */
function ModelCard({ model: m, fastest }: { model: ModelOption; fastest: number }): React.JSX.Element {
  const tps = m.tokens_per_second
  const share = tps && fastest ? tps / fastest : 0
  const tags = [
    m.reasoning && 'Reasoning',
    m.vision ? 'Vision' : 'Text',
    m.is_default && 'Default',
    m.is_default_fast && 'Fast default'
  ].filter(Boolean) as string[]

  return (
    <div className="model-card" aria-live="polite">
      <div className="model-card-head">
        <ModelLogo vendor={m.vendor} model={m.id} size={30} />
        <span className="menu-text">
          <b>{m.label}</b>
          <span>{m.vendor}</span>
        </span>
      </div>

      <div className="model-speed">
        <span className="model-stat-label">Speed</span>
        <div className="model-speed-value">
          {tps ? Math.round(tps) : '—'}
          <small>tok/s</small>
        </div>
        <div className="model-speed-bar">
          <span style={{ width: `${Math.max(share * 100, tps ? 4 : 0)}%` }} />
        </div>
      </div>

      <dl className="model-stats">
        <div>
          <dt>Context</dt>
          <dd>{formatTokens(m.context_window)}</dd>
        </div>
        <div>
          <dt>Input</dt>
          <dd>
            {formatPrice(m.input_price)}
            <small>/1M</small>
          </dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>
            {formatPrice(m.output_price)}
            <small>/1M</small>
          </dd>
        </div>
      </dl>

      <div className="model-tags">
        {tags.map((t) => (
          <span key={t} className="model-tag">
            {t}
          </span>
        ))}
      </div>

      <code className="model-card-id" title={m.id}>
        {m.id}
      </code>
    </div>
  )
}

function ContextMeter(): React.JSX.Element | null {
  const usage = useCoder((s) => s.usage)
  if (!usage.contextWindow || usage.contextTokens === 0) return null
  const pct = Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <span
      className={`context-meter${pct > 80 ? ' is-high' : ''}`}
      title={`Context: ${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} tokens (${pct.toFixed(0)}%). Older turns are summarised at 85%.`}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <circle cx="8" cy="8" r={r} className="ring-bg" />
        <circle
          cx="8"
          cy="8"
          r={r}
          className="ring"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {pct < 1 ? '<1' : pct.toFixed(0)}%
    </span>
  )
}

/** A small anchored popover; closes on outside click and Escape. */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'start',
  placement = 'top'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: React.ReactNode
  children: React.ReactNode
  align?: 'start' | 'end'
  placement?: 'top' | 'bottom'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])
  return (
    <div className="popover" ref={ref}>
      {trigger}
      {open && <div className={`popover-panel is-${placement} is-${align}`}>{children}</div>}
    </div>
  )
}
