import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentSummary, AppInfo, Memory } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { api } from '../api'
import { shortTime } from '../coder/toolMeta'
import { PageHead } from '../components/PageHead'
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
