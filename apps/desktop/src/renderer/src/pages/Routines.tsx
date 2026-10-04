import { CircleAlert, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  AgentSummary,
  Group,
  Routine,
  RoutineTrigger,
  Session
} from '../../../shared/contracts'
import { api } from '../api'
import { AgentAvatar } from '../components/AgentAvatar'
import { PageHead } from '../components/PageHead'
import { homeOf } from '../components/Sidebar'
import { GroupAvatar } from '../components/Team'
import { ROUTINES_CHANGED } from '../store/agentSession'
import { membersOf } from '../store/roster'

const REFRESH_MS = 15_000

const PRESETS: [string, string][] = [
  ['0 8 * * *', 'Every day at 08:00'],
  ['0 8 * * 1-5', 'Weekdays at 08:00'],
  ['0 9 * * 1', 'Mondays at 09:00'],
  ['0 * * * *', 'Every hour'],
  ['', 'Custom (cron)']
]

const EVENTS: [string, string][] = [
  ['pull_request.opened', 'A pull request is opened'],
  ['issues.opened', 'An issue is opened']
]

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const when = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

interface Props {
  agents: AgentSummary[]
  groups: Group[]
  onOpenSession: (session: Session) => void
}

/** Tasks an agent or a group runs by itself, on a schedule or when something happens on GitHub. */
export function Routines({ agents, groups, onOpenSession }: Props): React.JSX.Element {
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await api.routines.list()
    if (res.ok) setRoutines(res.data)
    else setError(res.error)
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    const onChange = (): void => void load()
    window.addEventListener(ROUTINES_CHANGED, onChange)
    return () => {
      clearInterval(timer)
      window.removeEventListener(ROUTINES_CHANGED, onChange)
    }
  }, [load])

  // Who can run a routine: agents whose conversations the app can show, and groups.
  const runners = agents.filter(
    (a) => a.status === 'ready' && a.id !== 'coder' && ['Chat', 'Research'].includes(homeOf(a) ?? '')
  )

  const replace = (r: Routine): void =>
    setRoutines((all) => (all ?? []).map((x) => (x.id === r.id ? r : x)))

  const toggle = async (r: Routine, enabled: boolean): Promise<void> => {
    const res = await api.routines.update(r.id, { enabled })
    if (res.ok) replace(res.data)
    else setError(res.error)
  }

  const runNow = async (r: Routine): Promise<void> => {
    setBusy(r.id)
    setError(null)
    const res = await api.routines.run(r.id)
    setBusy(null)
    if (res.ok) replace(res.data)
    else setError(res.error)
  }

  const remove = async (r: Routine): Promise<void> => {
    if (!window.confirm(`Delete the routine “${r.name}”? Its past conversations stay.`)) return
    const res = await api.routines.remove(r.id)
    if (res.ok) setRoutines((all) => (all ?? []).filter((x) => x.id !== r.id))
    else setError(res.error)
  }

  const open = async (sessionId: string): Promise<void> => {
    const res = await api.sessions.get(sessionId)
    if (res.ok) onOpenSession(res.data)
    else setError(res.error)
  }

  const who = (r: Routine): React.JSX.Element => {
    const group = r.group_id ? groups.find((g) => g.id === r.group_id) : undefined
    if (group) {
      return (
        <span className="routine-who">
          <GroupAvatar members={membersOf(group, agents)} size={18} /> {group.name}
        </span>
      )
    }
    const agent = agents.find((a) => a.id === r.agent_id)
    return (
      <span className="routine-who">
        {agent && <AgentAvatar agent={agent} size={18} bare />}
        {agent?.name ?? r.agent_id}
        {r.members && r.members.length > 0 && ` + ${r.members.length}`}
      </span>
    )
  }

  return (
    <div className="page">
      <PageHead
        title="Routines"
        subtitle="Work your agents do by themselves: on a schedule, or when something happens on GitHub."
      >
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus /> New routine
        </button>
      </PageHead>

      {error && (
        <div className="banner is-error">
          <CircleAlert />
          <span>{error}</span>
          <button className="icon-btn" onClick={() => setError(null)} title="Dismiss">
            <X />
          </button>
        </div>
      )}

      <section>
        <div className="list">
          {routines?.map((r) => (
            <div key={r.id} className={`row routine${r.enabled ? '' : ' is-off'}`}>
              <div className="row-body">
                <div className="row-title">
                  {r.name}
                  {r.running && <em className="badge">Running</em>}
                </div>
                <div className="row-why">
                  {who(r)} · {r.when}
                </div>
                <div className="row-why routine-times">
                  {r.enabled && r.next_run_at && <span>Next {when(r.next_run_at)}</span>}
                  {r.last_run_at && <span>Last {when(r.last_run_at)}</span>}
                  {!r.enabled && <span>Paused</span>}
                </div>
                {r.runs.length > 0 && (
                  <div className="routine-runs">
                    {r.runs
                      .slice(-5)
                      .reverse()
                      .map((run) => (
                        <button
                          key={`${run.started_at}`}
                          className={`routine-run is-${run.status}`}
                          disabled={!run.session_id}
                          title={run.note}
                          onClick={() => run.session_id && void open(run.session_id)}
                        >
                          <i />
                          {when(run.started_at)}
                          <span>{run.status === 'skipped' ? `skipped: ${run.note}` : run.note}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
              <button
                className="icon-btn"
                title="Run now"
                disabled={busy === r.id || r.running}
                onClick={() => void runNow(r)}
              >
                <Play />
              </button>
              <button className="icon-btn" title="Edit" onClick={() => setEditing(r)}>
                <Pencil />
              </button>
              <button className="icon-btn" title="Delete" onClick={() => void remove(r)}>
                <Trash2 />
              </button>
              <input
                type="checkbox"
                className="switch"
                checked={r.enabled}
                aria-label={r.enabled ? 'Pause' : 'Turn on'}
                onChange={(e) => void toggle(r, e.target.checked)}
              />
            </div>
          ))}
          {routines?.length === 0 && (
            <div className="row is-quiet">
              No routines yet. Make one here, or ask Polly to do something every morning.
            </div>
          )}
        </div>
        <p className="hint">
          Routines run while the Polly server is on. They cannot stop to ask you anything, so actions that
          need your approval are skipped.
        </p>
      </section>

      {editing && (
        <RoutineDialog
          routine={editing === 'new' ? null : editing}
          runners={runners}
          groups={groups}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null)
            setRoutines((all) =>
              all?.some((x) => x.id === r.id) ? all.map((x) => (x.id === r.id ? r : x)) : [...(all ?? []), r]
            )
          }}
        />
      )}
    </div>
  )
}

function RoutineDialog({
  routine,
  runners,
  groups,
  agents,
  onClose,
  onSaved
}: {
  routine: Routine | null
  runners: AgentSummary[]
  groups: Group[]
  agents: AgentSummary[]
  onClose: () => void
  onSaved: (r: Routine) => void
}): React.JSX.Element {
  const first = runners.find((a) => a.orchestrator) ?? runners[0]
  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [target, setTarget] = useState(
    routine ? (routine.group_id ?? routine.agent_id) : (first?.id ?? '')
  )
  const trigger = routine?.trigger
  const [kind, setKind] = useState<RoutineTrigger['kind']>(trigger?.kind ?? 'schedule')
  const [cron, setCron] = useState(trigger?.kind === 'schedule' ? trigger.cron : '0 8 * * 1-5')
  const [zone, setZone] = useState(trigger?.kind === 'schedule' ? trigger.timezone : LOCAL_ZONE)
  const [repo, setRepo] = useState(trigger?.kind === 'github' ? trigger.repo : '')
  const [event, setEvent] = useState(trigger?.kind === 'github' ? trigger.event : 'pull_request.opened')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const preset = PRESETS.some(([c]) => c === cron) ? cron : ''
  const ready =
    name.trim() && prompt.trim() && target && (kind === 'schedule' ? cron.trim() : repo.trim())

  const save = async (): Promise<void> => {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    const t: RoutineTrigger =
      kind === 'schedule'
        ? { kind, cron: cron.trim(), timezone: zone.trim() || 'UTC' }
        : { kind, repo: repo.trim(), event }
    const fields = { name: name.trim(), prompt: prompt.trim(), trigger: t }
    const isGroup = groups.some((g) => g.id === target)
    const res = routine
      ? await api.routines.update(routine.id, fields)
      : await api.routines.create({
          ...fields,
          ...(isGroup ? { group_id: target } : { agent_id: target })
        })
    setSaving(false)
    if (res.ok) onSaved(res.data)
    else setError(res.error)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal routine-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="routine-dialog-title"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <header className="modal-head">
          <div>
            <h2 id="routine-dialog-title">{routine ? `Edit ${routine.name}` : 'New routine'}</h2>
            <p>A message your agents get again and again, with no one watching.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <X />
          </button>
        </header>

        {error && (
          <div className="banner is-error modal-error">
            <CircleAlert />
            <span>{error}</span>
          </div>
        )}

        <div className="modal-body">
          <div className="field">
            <label htmlFor="routine-name">Name</label>
            <input
              id="routine-name"
              autoFocus
              value={name}
              maxLength={60}
              placeholder="Morning briefing"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="routine-who">Who runs it</label>
            <select
              id="routine-who"
              value={target}
              disabled={!!routine}
              onChange={(e) => setTarget(e.target.value)}
            >
              {runners.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.orchestrator ? ' (with the team it puts together)' : ''}
                </option>
              ))}
              {groups.length > 0 && (
                <optgroup label="Groups">
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({membersOf(g, agents).map((a) => a.name).join(', ')})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="routine-prompt">
              What to do<span className="count">{prompt.length}/4000</span>
            </label>
            <textarea
              id="routine-prompt"
              rows={5}
              value={prompt}
              maxLength={4000}
              placeholder="Summarise yesterday's top AI news in five bullet points, with links."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="field">
            <label>When</label>
            <span className="segmented">
              <button
                type="button"
                className={kind === 'schedule' ? 'is-active' : ''}
                onClick={() => setKind('schedule')}
              >
                On a schedule
              </button>
              <button
                type="button"
                className={kind === 'github' ? 'is-active' : ''}
                onClick={() => setKind('github')}
              >
                On a GitHub event
              </button>
            </span>
          </div>
          {kind === 'schedule' ? (
            <div className="routine-when">
              <div className="field">
                <label htmlFor="routine-preset">Repeat</label>
                <select
                  id="routine-preset"
                  value={preset}
                  onChange={(e) => e.target.value && setCron(e.target.value)}
                >
                  {PRESETS.map(([c, label]) => (
                    <option key={label} value={c}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="routine-cron">Cron</label>
                <input
                  id="routine-cron"
                  value={cron}
                  spellCheck={false}
                  placeholder="0 8 * * 1-5"
                  onChange={(e) => setCron(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="routine-zone">Time zone</label>
                <input
                  id="routine-zone"
                  value={zone}
                  spellCheck={false}
                  placeholder="Europe/London"
                  onChange={(e) => setZone(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="routine-when">
              <div className="field">
                <label htmlFor="routine-repo">Repository</label>
                <input
                  id="routine-repo"
                  value={repo}
                  spellCheck={false}
                  placeholder="owner/repo"
                  onChange={(e) => setRepo(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="routine-event">When</label>
                <select
                  id="routine-event"
                  value={event}
                  onChange={(e) => setEvent(e.target.value as typeof event)}
                >
                  {EVENTS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="hint">
                Needs GitHub connected on the Integrations page. Polly looks every minute; what is already
                there when the routine starts is left alone.
              </p>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <span className="composer-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || saving}>
            {saving ? 'Saving…' : routine ? 'Save' : 'Start routine'}
          </button>
        </footer>
      </form>
    </div>
  )
}
