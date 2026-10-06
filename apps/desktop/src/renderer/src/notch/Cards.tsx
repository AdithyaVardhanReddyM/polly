import {
  AlarmClock,
  Bell,
  Check,
  CircleCheck,
  Copy,
  Eye,
  History,
  KeyRound,
  Loader2,
  RotateCw,
  Sparkles,
  X
} from 'lucide-react'
import type { RecallHit, TodoItem, TodoProposal } from '../../../shared/contracts'
import { Markdown } from '../coder/Markdown'
import {
  acceptTodo,
  applyCard,
  copyCard,
  dismissCard,
  ignoreTodo,
  openRecall,
  reminderDone,
  snoozeReminder
} from './controller'
import type { Card } from './store'
import { useNotch } from './store'

const bridge = window.polly?.copilot

const KIND_LABEL: Record<string, string> = {
  reply_draft: 'Reply',
  completion: 'Suggestion',
  formula: 'Formula',
  fix: 'Fix',
  rewrite: 'Rewrite',
  answer: 'Answer',
  info: 'Info'
}

// Kinds whose stream is the suggestion itself, not markdown around it.
const PLAIN = new Set(['reply_draft', 'completion', 'rewrite'])

export function friendlyTime(seconds: number): string {
  const when = new Date(seconds * 1000)
  const now = new Date()
  const day = 86_400_000
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOf(when) - startOf(now)) / day)
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diff === 0) return `today ${time}`
  if (diff === 1) return `tomorrow ${time}`
  if (diff === -1) return `yesterday ${time}`
  if (diff > 1 && diff < 7) return `${when.toLocaleDateString([], { weekday: 'long' })} ${time}`
  return when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

function ago(seconds: number): string {
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 1440)} days ago`
}

function applyLabel(card: Card): string {
  if (card.applied === 'applying') return 'Applying…'
  if (card.applied === 'applied') return 'Applied'
  if (card.applied === 'failed') return 'Try again'
  const plan = card.apply
  if (plan?.kind === 'cell' && plan.cell) return `Apply to ${plan.cell}`
  if (plan?.kind === 'fill_fields') {
    const n = plan.fields?.length ?? 0
    return plan.fields?.every((f) => f.text === '' || f.text === '0')
      ? `Clear ${n} field${n === 1 ? '' : 's'}`
      : `Fill ${n} field${n === 1 ? '' : 's'}`
  }
  if (plan?.kind === 'replace_selection') return 'Replace selection'
  return 'Apply'
}

export function SuggestionCard({
  card,
  inline = false
}: {
  card: Card
  inline?: boolean
}): React.JSX.Element {
  const plain = PLAIN.has(card.kind)
  const streamingPlain = plain && !card.done
  const mono = card.apply?.kind === 'cell' || Boolean(card.suggestion?.trim().startsWith('='))
  const suggestion = streamingPlain ? card.text : card.suggestion
  const prose = streamingPlain ? '' : card.text
  return (
    <div className={`n-card${inline ? ' inline' : ''}`}>
      {!inline && (
        <div className="n-card-head">
          <span className="n-kind">
            {card.proactive ? <Sparkles size={13} /> : null}
            {KIND_LABEL[card.kind] ?? 'Answer'}
          </span>
          <span className="n-card-title">{card.title}</span>
          <button className="n-icon" title="Close" onClick={() => dismissCard(card)}>
            <X size={14} />
          </button>
        </div>
      )}

      {card.status && (
        <div className="n-status">
          <Loader2 size={13} className="n-spin" />
          {card.status}
        </div>
      )}

      {prose && (
        <div className="n-prose">
          <Markdown text={prose} />
        </div>
      )}

      {suggestion && (
        <div className={`n-suggestion${mono ? ' mono' : ''}`}>{suggestion}</div>
      )}

      {card.recall.length > 0 && <RecallList hits={card.recall} />}

      {card.sources.length > 0 && (
        <div className="n-sources">
          {card.sources.map((s) => (
            <span key={s.n} className="n-source" title={s.excerpt}>
              <b>{s.n}</b> {s.file_name}
              {s.page ? ` · p. ${s.page}` : ''}
            </span>
          ))}
        </div>
      )}

      {card.error && <div className="n-error">{card.error}</div>}

      {card.done && (card.apply || suggestion || prose || card.proactive) && (
        <div className="n-actions">
          {card.apply && (
            <button
              className={`n-btn primary${card.applied === 'applied' ? ' ok' : ''}`}
              disabled={card.applied === 'applying' || card.applied === 'applied'}
              onClick={() => void applyCard(card)}
            >
              {card.applied === 'applied' ? <Check size={14} /> : null}
              {applyLabel(card)}
            </button>
          )}
          {(suggestion || prose) && (
            <button className="n-btn" onClick={() => copyCard(card)}>
              <Copy size={13} />
              Copy
            </button>
          )}
          {card.proactive && (
            <>
              <button className="n-btn ghost" onClick={() => dismissCard(card)}>
                Ignore
              </button>
              <button className="n-btn ghost end" onClick={() => dismissCard(card, true)}>
                Don&apos;t show these
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RecallList({ hits }: { hits: RecallHit[] }): React.JSX.Element {
  return (
    <div className="n-recall">
      {hits.map((hit) => (
        <button key={hit.id} className="n-recall-row" onClick={() => openRecall(hit)}>
          <History size={14} />
          <span className="n-recall-main">
            <span className="n-recall-title">
              {hit.window || hit.app}
              <span className="n-faint"> · {hit.app} · {ago(hit.at)}</span>
            </span>
            <span className="n-recall-excerpt">{hit.excerpt}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function TodoCard({ todo }: { todo: TodoProposal }): React.JSX.Element {
  return (
    <div className="n-card todo">
      <div className="n-card-head">
        <span className="n-kind">
          <CircleCheck size={13} />
          To-do detected
        </span>
        {todo.source.app && <span className="n-from">from {todo.source.app}</span>}
      </div>
      <div className="n-todo-title">{todo.title}</div>
      {todo.due_at && (
        <div className="n-meta">
          <AlarmClock size={13} />
          Due {friendlyTime(todo.due_at)}
        </div>
      )}
      {todo.evidence[0] && <div className="n-quote">{todo.evidence[0]}</div>}
      <div className="n-actions">
        <button className="n-btn primary" onClick={() => void acceptTodo(todo)}>
          Accept
        </button>
        <button className="n-btn ghost" onClick={() => ignoreTodo(todo)}>
          Ignore
        </button>
      </div>
    </div>
  )
}

export function ReminderCard({ todo }: { todo: TodoItem }): React.JSX.Element {
  return (
    <div className="n-card reminder">
      <div className="n-card-head">
        <span className="n-kind">
          <Bell size={13} />
          Reminder
        </span>
        {todo.due_at && <span className="n-from">due {friendlyTime(todo.due_at)}</span>}
      </div>
      <div className="n-todo-title">{todo.title}</div>
      <div className="n-actions">
        <button className="n-btn primary" onClick={() => void reminderDone(todo.id)}>
          <Check size={14} />
          Done
        </button>
        <button className="n-btn" onClick={() => void snoozeReminder(todo.id, 10)}>
          Snooze 10 min
        </button>
        <button className="n-btn ghost end" onClick={() => void bridge?.openMain('home')}>
          All to-dos
        </button>
      </div>
    </div>
  )
}

/** Shown while something stops the copilot from seeing: permissions, the helper, the server. */
export function Notices(): React.JSX.Element | null {
  const copilot = useNotch((s) => s.copilot)
  const serverDown = useNotch((s) => s.serverDown)
  const excluded = useNotch((s) => s.excluded)
  if (!copilot) return null
  const { helper, permissions, watching } = copilot

  if (serverDown) {
    return (
      <div className="n-card notice">
        <div className="n-notice-title">Polly&apos;s server isn&apos;t running</div>
        <div className="n-notice-text">
          Start it with <code>npm run dev</code> (or <code>npm run dev:server</code>) in the repo.
        </div>
      </div>
    )
  }
  if (helper.state === 'missing') {
    return (
      <div className="n-card notice">
        <div className="n-notice-title">The screen reader isn&apos;t built yet</div>
        <div className="n-notice-text">
          Run <code>npm run build:sense</code> in the repo, then restart Polly.
        </div>
      </div>
    )
  }
  if (helper.state === 'error') {
    return (
      <div className="n-card notice">
        <div className="n-notice-title">Polly Sense stopped</div>
        <div className="n-notice-text">{helper.message}</div>
        <div className="n-actions">
          <button className="n-btn" onClick={() => void bridge?.restartHelper()}>
            <RotateCw size={13} />
            Restart it
          </button>
        </div>
      </div>
    )
  }
  if (watching && helper.state === 'ready' && (!permissions.accessibility || !permissions.screenRecording)) {
    return (
      <div className="n-card notice">
        <div className="n-notice-title">Polly needs two permissions to see your screen</div>
        <div className="n-perm">
          <KeyRound size={15} />
          <span className="n-perm-text">
            <b>Accessibility</b>
            <span>Read text in apps and put suggestions back</span>
          </span>
          {permissions.accessibility ? (
            <span className="n-granted">
              <Check size={14} /> Allowed
            </span>
          ) : (
            <button
              className="n-btn primary"
              onClick={() => void bridge?.requestPermission('accessibility')}
            >
              Allow
            </button>
          )}
        </div>
        <div className="n-perm">
          <Eye size={15} />
          <span className="n-perm-text">
            <b>Screen Recording</b>
            <span>See the window you&apos;re working in</span>
          </span>
          {permissions.screenRecording ? (
            <span className="n-granted">
              <Check size={14} /> Allowed
            </span>
          ) : (
            <button
              className="n-btn primary"
              onClick={() => void bridge?.requestPermission('screenRecording')}
            >
              Allow
            </button>
          )}
        </div>
        <div className="n-notice-text small">
          Turn on <b>Polly Sense</b> in System Settings. If it still shows as not allowed,{' '}
          <button className="n-link" onClick={() => void bridge?.restartHelper()}>
            restart Polly Sense
          </button>
          .
        </div>
      </div>
    )
  }
  if (watching && excluded) {
    return (
      <div className="n-card notice quiet">
        <div className="n-notice-title">Polly isn&apos;t looking at {excluded.app}</div>
        <div className="n-notice-text">
          {excluded.reason === 'hidden' || excluded.reason === 'window'
            ? 'You hid this window.'
            : excluded.reason === 'self'
              ? 'This is Polly itself.'
              : 'It is excluded in your privacy settings.'}{' '}
          <button className="n-link" onClick={() => void bridge?.openMain('settings')}>
            Privacy settings
          </button>
        </div>
      </div>
    )
  }
  return null
}
