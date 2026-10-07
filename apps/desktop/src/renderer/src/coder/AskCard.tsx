import {
  CalendarClock,
  Check,
  KeyRound,
  MessageCircleQuestion,
  Plug,
  SquareTerminal,
  UserPlus,
  Users
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AskAnswer, AskRequired } from '../../../shared/contracts'
import { api } from '../api'
import { AgentAvatar } from '../components/AgentAvatar'
import type { AgentStore } from '../store/agentSession'
import { useRoster } from '../store/roster'

const POLL_MS = 2500

type Of<K extends AskRequired['kind']> = Extract<AskRequired, { kind: K }>

/** The card a run waits on: nothing happens until the user answers it. */
export function AskCard({ store }: { store: AgentStore }): React.JSX.Element | null {
  const ask = store((s) => s.pendingAsk)
  const answer = store((s) => s.answer)
  const [busy, setBusy] = useState(false)

  useEffect(() => setBusy(false), [ask])

  if (!ask) return null
  const reply = (value: AskAnswer): void => {
    if (busy) return
    setBusy(true)
    void answer(value)
  }
  const props = { busy, reply }
  return (
    <div className={`ask ask-${ask.kind}`} role="group" aria-label="Polly needs your answer">
      {ask.kind === 'hire' && <Hire ask={ask} {...props} />}
      {ask.kind === 'question' && <Question ask={ask} {...props} />}
      {ask.kind === 'connect' && <Connect ask={ask} {...props} />}
      {ask.kind === 'variables' && <Variables ask={ask} {...props} />}
      {ask.kind === 'confirm' && <Confirm ask={ask} {...props} />}
    </div>
  )
}

interface Props<K extends AskRequired['kind']> {
  ask: Of<K>
  busy: boolean
  reply: (value: AskAnswer) => void
}

function Head({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="ask-head">
      {icon}
      <b>{children}</b>
    </div>
  )
}

/** Approve or reject, with an optional word on why not. */
function Decide({
  busy,
  reply,
  approve,
  reject = 'Not now',
  why
}: {
  busy: boolean
  reply: (value: AskAnswer) => void
  approve: string
  reject?: string
  why?: string
}): React.JSX.Element {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  if (rejecting) {
    return (
      <div className="ask-foot">
        <input
          className="ask-input"
          autoFocus
          maxLength={500}
          placeholder={why ?? 'What should Polly do instead? (optional)'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') reply({ approved: false, answer: reason.trim() || undefined })
            if (e.key === 'Escape') setRejecting(false)
          }}
        />
        <button className="btn" onClick={() => setRejecting(false)} disabled={busy}>
          Back
        </button>
        <button
          className="btn btn-danger"
          onClick={() => reply({ approved: false, answer: reason.trim() || undefined })}
          disabled={busy}
        >
          {reject}
        </button>
      </div>
    )
  }
  return (
    <div className="ask-foot">
      <button className="btn btn-primary" onClick={() => reply({ approved: true })} disabled={busy}>
        <Check /> {approve}
      </button>
      <span className="ask-spacer" />
      <button className="btn btn-ghost" onClick={() => setRejecting(true)} disabled={busy}>
        {reject}
      </button>
    </div>
  )
}

function Hire({ ask, busy, reply }: Props<'hire'>): React.JSX.Element {
  const { agent } = ask
  return (
    <>
      <Head icon={<UserPlus />}>Polly wants to make a new agent for this</Head>
      <div className="hire">
        <div className="hire-strap" aria-hidden />
        <div className="hire-badge">
          <AgentAvatar
            agent={{ avatar: agent.avatar, division: 'custom', name: agent.name }}
            size={72}
            motion="slow"
          />
          <div className="hire-name">
            <b>{agent.name}</b>
            <span>{agent.tagline}</span>
          </div>
        </div>
      </div>
      {agent.description && <p className="ask-text">{agent.description}</p>}
      {ask.reason && <p className="ask-why">{ask.reason}</p>}
      {(agent.sandbox || agent.apps.length > 0 || agent.variables.length > 0) && (
        <div className="ask-chips">
          {agent.sandbox && (
            <span>
              <SquareTerminal /> Code sandbox
            </span>
          )}
          {agent.apps.map((a) => (
            <span key={a.slug} className={a.connected ? '' : 'is-todo'} title={a.connected ? 'Connected' : 'Not connected yet'}>
              <Plug /> {a.name}
            </span>
          ))}
          {agent.variables.map((v) => (
            <span key={v.name} className={v.is_set ? '' : 'is-todo'} title={v.is_set ? 'Set' : 'Not set yet'}>
              <KeyRound /> <code>{v.name}</code>
            </span>
          ))}
        </div>
      )}
      <Decide busy={busy} reply={reply} approve={`Hire ${agent.name}`} reject="Don't hire" />
    </>
  )
}

function Question({ ask, busy, reply }: Props<'question'>): React.JSX.Element {
  const [text, setText] = useState('')
  const send = (value: string): void => {
    if (value.trim()) reply({ answer: value.trim() })
  }
  return (
    <>
      <Head icon={<MessageCircleQuestion />}>{ask.question}</Head>
      {ask.options.length > 0 && (
        <div className="ask-options">
          {ask.options.map((o) => (
            <button key={o} className="btn" onClick={() => send(o)} disabled={busy}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="ask-foot"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <input
          className="ask-input"
          maxLength={4000}
          autoFocus={ask.options.length === 0}
          placeholder={ask.options.length ? 'Or write your own answer' : 'Your answer'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </>
  )
}

function Connect({ ask, busy, reply }: Props<'connect'>): React.JSX.Element {
  const [waiting, setWaiting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!waiting || connected) return
    const timer = setInterval(() => {
      void api.integrations.status(true).then((res) => {
        if (res.ok && res.data.items.some((i) => i.slug === ask.app.slug && i.state === 'connected'))
          setConnected(true)
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [waiting, connected, ask.app.slug])

  const connect = async (): Promise<void> => {
    setError(null)
    const res = await api.integrations.connect(ask.app.slug)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setWaiting(true)
    window.open(res.data.url, '_blank')
  }

  return (
    <>
      <Head icon={<Plug />}>
        {ask.agent.name} needs {ask.app.name}
      </Head>
      {ask.app.description && <p className="ask-text">{ask.app.description}</p>}
      <p className="ask-why">
        {connected
          ? `${ask.app.name} is connected.`
          : waiting
            ? `Finish signing in to ${ask.app.name} in your browser; this card notices when you are done.`
            : `Sign in to ${ask.app.name} so ${ask.agent.name} can act in it for you.`}
      </p>
      {error && <p className="ask-error">{error}</p>}
      <div className="ask-foot">
        {connected ? (
          <button className="btn btn-primary" onClick={() => reply({ connected: true })} disabled={busy}>
            <Check /> Continue
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void connect()} disabled={busy}>
            <Plug /> {waiting ? 'Open the sign-in again' : `Connect ${ask.app.name}`}
          </button>
        )}
        <span className="ask-spacer" />
        <button className="btn btn-ghost" onClick={() => reply({ connected: false })} disabled={busy}>
          {connected ? 'Back' : 'Skip'}
        </button>
      </div>
    </>
  )
}

function Variables({ ask, busy, reply }: Props<'variables'>): React.JSX.Element {
  const agents = useRoster((s) => s.agents)
  const who = agents.find((a) => a.id === ask.agent)?.name
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filled = ask.variables.filter((v) => (values[v.name] ?? '').length > 0)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    for (const v of filled) {
      const res = await api.variables.put(v.name, {
        value: values[v.name],
        secret: v.secret,
        description: v.description || undefined
      })
      if (!res.ok) {
        setError(`${v.name}: ${res.error}`)
        setSaving(false)
        return
      }
    }
    setSaving(false)
    // Values never go through the chat: the agent only learns they are set.
    setValues({})
    reply({ done: true })
  }

  return (
    <>
      <Head icon={<KeyRound />}>
        {who ? `${who} needs` : 'Polly needs'} {ask.variables.length === 1 ? 'a setting' : 'some settings'}
      </Head>
      {ask.why && <p className="ask-why">{ask.why}</p>}
      <form
        className="ask-fields"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {ask.variables.map((v, i) => (
          <label key={v.name} className="ask-field">
            <span>
              <code>{v.name}</code>
              {v.description && <em>{v.description}</em>}
            </span>
            <input
              className="ask-input"
              type={v.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              autoFocus={i === 0}
              maxLength={10000}
              value={values[v.name] ?? ''}
              onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
            />
          </label>
        ))}
        <p className="ask-note">
          Kept on this machine, not in the chat. Agents can use them but never see secret values. Change them
          any time in Settings → Variables.
        </p>
        {error && <p className="ask-error">{error}</p>}
        <div className="ask-foot">
          <button className="btn btn-primary" type="submit" disabled={busy || saving || filled.length === 0}>
            <Check /> {saving ? 'Saving…' : 'Save and continue'}
          </button>
          <span className="ask-spacer" />
          <button className="btn btn-ghost" type="button" onClick={() => reply({ done: false })} disabled={busy || saving}>
            Skip
          </button>
        </div>
      </form>
    </>
  )
}

function Confirm({ ask, busy, reply }: Props<'confirm'>): React.JSX.Element {
  const routine = ask.action === 'routine'
  return (
    <>
      <Head icon={routine ? <CalendarClock /> : <Users />}>{ask.title}</Head>
      {ask.detail && <p className="ask-why">{ask.detail}</p>}
      {ask.task && <pre className="ask-task">{ask.task}</pre>}
      {routine && (
        <p className="ask-note">
          It runs by itself and cannot stop to ask you anything. Pause or remove it on the Routines page.
        </p>
      )}
      <Decide busy={busy} reply={reply} approve={routine ? 'Start it' : 'Save team'} reject="No" />
    </>
  )
}
