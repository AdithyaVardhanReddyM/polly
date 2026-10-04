import { Check, CircleAlert, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentSummary, AppInfo, Memory, Variable } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { api } from '../api'
import { shortTime } from '../coder/toolMeta'
import { AgentAvatar } from '../components/AgentAvatar'
import { PageHead } from '../components/PageHead'
import { useRoster } from '../store/roster'
import { type StageArt, useStageArt } from '../components/StageArt'
import { type ThemePref, useTheme } from '../theme'

const STAGES: [StageArt, string][] = [
  ['pixel', 'Pixel'],
  ['blueprint', 'Blueprint'],
  ['off', 'Off']
]

interface Props {
  server: ServerState
  agents: AgentSummary[]
  onRecheck: () => void
}

export function Settings({ server, agents, onRecheck }: Props): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [theme, setTheme] = useTheme()
  const [art, setArt] = useStageArt()
  const collaboration = useRoster((s) => s.open)
  const setCollaboration = useRoster((s) => s.setOpen)

  useEffect(() => {
    void window.polly?.appInfo().then((r) => r.ok && setInfo(r.data))
  }, [])

  const h = server.health
  const rows: [string, string, boolean | null][] = h
    ? [
        ['Agent server', `${h.service} ${h.version}`, true],
        ['Model', `${h.model.provider} · ${h.model.id}`, h.model.configured],
        ['Sandboxes', h.sandbox.provider, h.sandbox.configured],
        ['Web search', h.search.provider, h.search.configured]
      ]
    : [['Agent server', server.error ?? 'Connecting…', false]]

  return (
    <div className="page">
      <PageHead title="Settings" subtitle="Where Polly runs and what it is connected to.">
        <button className="btn" onClick={onRecheck} disabled={server.checking}>
          {server.checking ? 'Checking…' : 'Recheck'}
        </button>
      </PageHead>

      <section>
        <div className="section-head">
          <h2>Runtime</h2>
        </div>
        <div className="list">
          {rows.map(([label, value, ok]) => (
            <div key={label} className="row is-setting">
              <span className="setting-label">{label}</span>
              <span className="row-body setting-value">{value}</span>
              <span className={ok ? 'dot dot-ok' : 'dot dot-warn'} />
            </div>
          ))}
        </div>
        <p className="hint">Keys live in the repo-root <code>.env</code>; see <code>.env.example</code>.</p>
      </section>

      <MemorySection agents={agents} />

      <VariablesSection agents={agents} />

      <section>
        <div className="section-head">
          <h2>Collaboration</h2>
          <span>How your agents work together.</span>
        </div>
        <div className="list">
          <label className="row is-toggle">
            <div className="row-body">
              <div className="row-title">Open collaboration</div>
              <div className="row-why">
                Every agent can hand work to any other. When this is off, an agent calls only on the
                teammates you picked for it, on the Agents page or in a conversation.
              </div>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={collaboration}
              onChange={(e) => void setCollaboration(e.target.checked)}
            />
          </label>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Appearance</h2>
        </div>
        <div className="list">
          <div className="row is-setting">
            <span className="setting-label">Theme</span>
            <span className="row-body">
              <span className="segmented">
                {(['light', 'dark', 'system'] as ThemePref[]).map((t) => (
                  <button
                    key={t}
                    className={t === theme ? 'is-active' : ''}
                    onClick={() => setTheme(t)}
                  >
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </span>
            </span>
          </div>
          <div className="row is-setting">
            <span className="setting-label">Header art</span>
            <span className="row-body">
              <span className="segmented">
                {STAGES.map(([a, label]) => (
                  <button key={a} className={a === art ? 'is-active' : ''} onClick={() => setArt(a)}>
                    {label}
                  </button>
                ))}
              </span>
            </span>
          </div>
        </div>
      </section>

      {info && (
        <section>
          <div className="section-head">
            <h2>App</h2>
          </div>
          <div className="list">
            <div className="row is-setting">
              <span className="setting-label">Version</span>
              <span className="row-body setting-value">
                {info.version} · Electron {info.electron} · Node {info.node} · {info.platform}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

/** What Polly remembers about the user: every agent with memory reads and adds to it. */
function MemorySection({ agents }: { agents: AgentSummary[] }): React.JSX.Element {
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const take = (res: Awaited<ReturnType<typeof api.memory.list>>): void => {
    if (res.ok) setMemories(res.data)
    setError(res.ok ? null : res.error)
  }

  useEffect(() => {
    void api.memory.list().then(take)
  }, [])

  const add = async (): Promise<void> => {
    if (!draft.trim()) return
    const text = draft.trim()
    setDraft('')
    take(await api.memory.add(text))
  }

  const by = (source: string): string =>
    source === 'user' ? 'You' : (agents.find((a) => a.id === source)?.name ?? 'An agent')

  return (
    <section>
      <div className="section-head">
        <h2>Memory</h2>
        <span>What Polly knows about you. Every agent with memory reads and adds to it.</span>
      </div>
      <div className="list">
        <form
          className="row memory-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            value={draft}
            maxLength={400}
            placeholder="Tell Polly something to remember, such as how you like answers written"
            aria-label="Add a memory"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!draft.trim()}>
            <Plus /> Add
          </button>
        </form>
        {memories?.map((m) => (
          <div key={m.id} className="row">
            <div className="row-body">
              <div className="row-title memory-text">{m.text}</div>
              <div className="row-why">
                {by(m.source)} · {shortTime(m.created_at)}
              </div>
            </div>
            <button
              className="icon-btn"
              title="Forget this"
              onClick={() => void api.memory.remove(m.id).then(take)}
            >
              <Trash2 />
            </button>
          </div>
        ))}
        {memories?.length === 0 && (
          <div className="row is-quiet">Nothing yet. Agents save what you tell them about yourself.</div>
        )}
      </div>
      {error && <p className="hint">{error}</p>}
      {memories && memories.length > 1 && (
        <p className="hint">
          <button
            className="link"
            onClick={() => {
              if (window.confirm('Forget everything Polly remembers about you?'))
                void api.memory.clear().then(take)
            }}
          >
            Forget everything
          </button>
        </p>
      )}
    </section>
  )
}

/** Settings and keys agents use: secrets go into an agent's sandbox, never into its prompt. */
function VariablesSection({ agents }: { agents: AgentSummary[] }): React.JSX.Element {
  const [list, setList] = useState<Variable[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Variable | 'new' | null>(null)

  const load = async (): Promise<void> => {
    const res = await api.variables.list()
    if (res.ok) setList(res.data)
    setError(res.ok ? null : res.error)
  }

  useEffect(() => {
    void load()
  }, [])

  const remove = async (v: Variable): Promise<void> => {
    if (!window.confirm(`Delete ${v.name}? Agents that use it will no longer have it.`)) return
    const res = await api.variables.remove(v.name)
    if (res.ok) setList(res.data)
    setError(res.ok ? null : res.error)
  }

  const names = (ids: string[]): string =>
    ids.length === 0
      ? 'Every agent'
      : ids.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(', ')

  return (
    <section id="variables">
      <div className="section-head">
        <h2>Variables</h2>
        <span>Settings and keys your agents need. Secret values never leave this machine's server.</span>
      </div>
      <div className="list">
        {list?.map((v) => (
          <div key={v.name} className="row variable">
            <KeyRound className="variable-icon" />
            <div className="row-body">
              <div className="row-title">
                <code>{v.name}</code>
                <em className={v.is_set ? 'badge' : 'badge is-warn'}>
                  {v.is_set ? (v.secret ? 'Secret · set' : 'Set') : 'Not set'}
                </em>
              </div>
              <div className="row-why">
                {v.description && `${v.description} · `}
                {!v.secret && v.value ? <code>{v.value}</code> : null}
                {!v.secret && v.value ? ' · ' : ''}
                {names(v.agents)}
              </div>
            </div>
            <button className="icon-btn" title={v.is_set ? 'Change' : 'Set'} onClick={() => setEditing(v)}>
              <Pencil />
            </button>
            <button className="icon-btn" title="Delete" onClick={() => void remove(v)}>
              <Trash2 />
            </button>
          </div>
        ))}
        {list?.length === 0 && (
          <div className="row is-quiet">
            None yet. Add an API key or a setting, or Polly asks for one when an agent needs it.
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus /> Add variable
          </button>
        </div>
      </div>
      {error && <p className="hint">{error}</p>}
      {editing && (
        <VariableDialog
          variable={editing === 'new' ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </section>
  )
}

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/

function VariableDialog({
  variable,
  agents,
  onClose,
  onSaved
}: {
  variable: Variable | null
  agents: AgentSummary[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [name, setName] = useState(variable?.name ?? '')
  const [value, setValue] = useState(variable?.secret ? '' : (variable?.value ?? ''))
  const [description, setDescription] = useState(variable?.description ?? '')
  const [secret, setSecret] = useState(variable?.secret ?? true)
  const [allowed, setAllowed] = useState<string[]>(variable?.agents ?? [])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const pool = agents.filter((a) => a.status === 'ready' && a.id !== 'coder')
  // A secret that is set keeps its value unless a new one is typed.
  const keeps = !!variable?.is_set && secret && variable.secret
  const validName = NAME.test(name)
  const ready = validName && (keeps || value.length > 0 || (!!variable && !secret))

  const toggle = (id: string): void =>
    setAllowed((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const save = async (): Promise<void> => {
    if (!ready || saving) return
    setSaving(true)
    const res = await api.variables.put(name, {
      ...(value.length > 0 || !secret ? { value } : {}),
      description: description.trim(),
      secret,
      agents: allowed
    })
    setSaving(false)
    if (res.ok) onSaved()
    else setError(res.error)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="variable-dialog-title"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <header className="modal-head">
          <div>
            <h2 id="variable-dialog-title">{variable ? variable.name : 'New variable'}</h2>
            <p>
              Secrets are set in an agent's sandbox as <code>$NAME</code>; settings that are not secret
              also go in its instructions.
            </p>
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
          {!variable && (
            <div className="field">
              <label htmlFor="variable-name">
                Name<span>Capitals, digits and _</span>
              </label>
              <input
                id="variable-name"
                autoFocus
                value={name}
                maxLength={64}
                spellCheck={false}
                placeholder="OPENWEATHER_API_KEY"
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="variable-value">Value</label>
            <input
              id="variable-value"
              autoFocus={!!variable}
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              maxLength={10000}
              value={value}
              placeholder={keeps ? 'Set · type a new value to replace it' : ''}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="variable-about">What it is for</label>
            <input
              id="variable-about"
              value={description}
              maxLength={200}
              placeholder="Weather data for the morning briefing"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <label className="switch-row">
            <span>
              Secret
              <span>Agents can use it but never see it; it is hidden from their output.</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={secret}
              onChange={(e) => setSecret(e.target.checked)}
            />
          </label>
          <div className="field">
            <label id="variable-agents-label">
              Who may use it<span>{allowed.length === 0 ? 'Every agent' : `${allowed.length} chosen`}</span>
            </label>
            <div className="pick-list" role="group" aria-labelledby="variable-agents-label">
              {pool.map((a) => {
                const on = allowed.includes(a.id)
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={on ? 'pick is-on' : 'pick'}
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(a.id)}
                  >
                    <AgentAvatar agent={a} size={28} />
                    <span className="pick-text">
                      <b>{a.name}</b>
                      <span>{a.tagline}</span>
                    </span>
                    <span className="pick-box" aria-hidden>
                      {on && <Check />}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <footer className="modal-foot">
          <span className="composer-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}
