import {
  ArrowUpRight,
  Check,
  ExternalLink,
  Globe,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
  Unplug,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentSummary, Integration, IntegrationsStatus } from '../../../shared/contracts'
import { api, serverUrl } from '../api'
import { AgentAvatar } from '../components/AgentAvatar'
import { PageHead } from '../components/PageHead'

/** How often to ask whether a sign-in finished, and when to stop asking. */
const POLL_MS = 2500
const GIVE_UP_MS = 5 * 60_000

/** A sign-in that is open in the browser. */
interface Pending {
  url: string
  since: number
}

const STATE_LABEL: Record<Integration['state'], string> = {
  connected: 'Connected',
  expired: 'Sign in again',
  available: 'Not connected',
  ready: 'No account needed'
}

export function Integrations({ agents }: { agents: AgentSummary[] }): React.JSX.Element {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [base, setBase] = useState<string | null>(null)

  useEffect(() => {
    void serverUrl().then(setBase)
  }, [])

  const load = useCallback(async (fresh = false) => {
    const res = await api.integrations.status(fresh)
    if (res.ok) {
      setStatus(res.data)
      setError(null)
      // A sign-in is over once the account shows up.
      setPending((p) => {
        const done = res.data.items.filter((i) => i.state === 'connected' && p[i.slug])
        if (done.length === 0) return p
        const next = { ...p }
        for (const i of done) delete next[i.slug]
        return next
      })
    } else setError(res.error)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const waiting = Object.keys(pending).length > 0
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      setPending((p) => {
        const live = Object.entries(p).filter(([, v]) => Date.now() - v.since < GIVE_UP_MS)
        return live.length === Object.keys(p).length ? p : Object.fromEntries(live)
      })
      void load(true)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [waiting, load])

  const note = (slug: string, text: string | null): void =>
    setNotes((n) => {
      const next = { ...n }
      if (text) next[slug] = text
      else delete next[slug]
      return next
    })

  const connect = async (slug: string): Promise<void> => {
    note(slug, null)
    setPending((p) => ({ ...p, [slug]: { url: '', since: Date.now() } }))
    const res = await api.integrations.connect(slug)
    if (!res.ok) {
      setPending(({ [slug]: _, ...rest }) => rest)
      note(slug, res.error)
      setOpenSlug(slug)
      return
    }
    setPending((p) => ({ ...p, [slug]: { url: res.data.url, since: Date.now() } }))
    window.open(res.data.url, '_blank')
  }

  const cancel = (slug: string): void => setPending(({ [slug]: _, ...rest }) => rest)

  const disconnect = async (slug: string): Promise<void> => {
    note(slug, null)
    const res = await api.integrations.disconnect(slug)
    if (res.ok) setStatus(res.data)
    else note(slug, res.error)
  }

  const toggleAgent = async (slug: string, agentId: string, on: boolean): Promise<void> => {
    if (!status) return
    const current = status.items.filter((i) => i.agents.includes(agentId)).map((i) => i.slug)
    const next = on ? [...current, slug] : current.filter((s) => s !== slug)
    // Show the change at once; the reload below corrects it if saving failed.
    setStatus({
      ...status,
      items: status.items.map((i) =>
        i.slug === slug
          ? { ...i, agents: on ? [...i.agents, agentId] : i.agents.filter((a) => a !== agentId) }
          : i
      )
    })
    const res = await api.integrations.setForAgent(agentId, next)
    if (!res.ok) note(slug, res.error)
    await load()
  }

  const items = useMemo(() => status?.items ?? [], [status])
  const connectedCount = items.filter((i) => i.state === 'connected').length
  const usable = status?.composio.configured ?? false

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      if (q && !`${i.name} ${i.description} ${i.slug}`.toLowerCase().includes(q)) return false
      if (filter === 'all') return true
      if (filter === 'connected') return i.state === 'connected' || i.state === 'expired'
      return i.category === filter
    })
  }, [items, query, filter])

  // Browsing everything reads best by category; a search or a filter is one flat list.
  const grouped = filter === 'all' && !query.trim()
  const open = items.find((i) => i.slug === openSlug) ?? null
  const cardProps = (i: Integration): CardProps => ({
    item: i,
    base,
    agents,
    usable,
    pending: pending[i.slug],
    onOpen: () => setOpenSlug(i.slug),
    onConnect: () => void connect(i.slug),
    onCancel: () => cancel(i.slug)
  })

  return (
    <div className="page ig-page">
      <PageHead
        title="Integrations"
        subtitle="Connect your apps once, then give each agent only the ones it needs."
      >
        <label className="ig-search">
          <Search />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            spellCheck={false}
          />
        </label>
      </PageHead>

      {error && <div className="empty">{error}</div>}

      {status && !status.composio.configured && (
        <div className="ig-banner">
          <KeyRound />
          <div>
            <b>Add a Composio key to connect apps</b>
            <p>
              Set <code>COMPOSIO_API_KEY</code> in <code>.env</code> and restart the server. Sign-ins
              and tokens are handled by Composio, so nothing sensitive is stored on this machine.
            </p>
          </div>
        </div>
      )}

      {status && (
        <section className="ig-builtin">
          <Logo slug="tavily" name="Tavily" base={base} size={34} />
          <div className="ig-builtin-body">
            <div className="ig-builtin-title">
              Web search <span>by Tavily</span>
            </div>
            <p>Search and page reading, built in to every agent. Nothing to connect.</p>
          </div>
          {status.tavily.configured ? (
            <span className="ig-state is-connected">
              <Check /> Ready
            </span>
          ) : (
            <span className="ig-state is-expired">
              Add <code>TAVILY_API_KEY</code> to <code>.env</code>
            </span>
          )}
        </section>
      )}

      {status && (
        <div className="ig-filters" role="tablist">
          <FilterPill id="all" label="All apps" count={items.length} active={filter} onPick={setFilter} />
          <FilterPill
            id="connected"
            label="Connected"
            count={connectedCount}
            active={filter}
            onPick={setFilter}
          />
          <span className="ig-filters-rule" />
          {status.categories.map((c) => (
            <FilterPill key={c.id} id={c.id} label={c.label} active={filter} onPick={setFilter} />
          ))}
        </div>
      )}

      {status && shown.length === 0 && (
        <div className="empty">
          {filter === 'connected' && !query.trim()
            ? 'Nothing connected yet. Pick an app to get started.'
            : 'No apps match that.'}
        </div>
      )}

      {grouped ? (
        status?.categories.map((c) => {
          const inCategory = shown.filter((i) => i.category === c.id)
          if (inCategory.length === 0) return null
          return (
            <section key={c.id}>
              <div className="section-head">
                <h2>{c.label}</h2>
                <span>{inCategory.length}</span>
              </div>
              <div className="ig-grid">
                {inCategory.map((i) => (
                  <Card key={i.slug} {...cardProps(i)} />
                ))}
              </div>
            </section>
          )
        })
      ) : (
        <div className="ig-grid">
          {shown.map((i) => (
            <Card key={i.slug} {...cardProps(i)} />
          ))}
        </div>
      )}

      {status && (
        <p className="ig-foot">
          <ShieldCheck /> Sign-ins run through Composio. Polly never sees your passwords or tokens,
          and you can disconnect an app at any time.
        </p>
      )}

      {open && (
        <Detail
          item={open}
          base={base}
          agents={agents}
          usable={usable}
          category={status?.categories.find((c) => c.id === open.category)?.label ?? ''}
          pending={pending[open.slug]}
          note={notes[open.slug]}
          onClose={() => setOpenSlug(null)}
          onConnect={() => void connect(open.slug)}
          onCancel={() => cancel(open.slug)}
          onDisconnect={() => disconnect(open.slug)}
          onToggle={(agentId, on) => void toggleAgent(open.slug, agentId, on)}
        />
      )}
    </div>
  )
}

function FilterPill({
  id,
  label,
  count,
  active,
  onPick
}: {
  id: string
  label: string
  count?: number
  active: string
  onPick: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active === id}
      className={active === id ? 'ig-pill is-active' : 'ig-pill'}
      onClick={() => onPick(id)}
    >
      {label}
      {count !== undefined && <span>{count}</span>}
    </button>
  )
}

/** The resolved theme on <html>, so logos can match the background they sit on. */
function useResolvedTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  const [theme, setThemeState] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeState(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** The app's logo, served by the agent server; a letter until it loads or if it cannot. */
function Logo({
  slug,
  name,
  base,
  size
}: {
  slug: string
  name: string
  base: string | null
  size: number
}): React.JSX.Element {
  const theme = useResolvedTheme()
  const [failed, setFailed] = useState(false)
  return (
    <span className="ig-logo" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {base && !failed ? (
        <img
          src={`${base}/integrations/${slug}/logo?theme=${theme}`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        name.charAt(0)
      )}
    </span>
  )
}

function StateBadge({ item }: { item: Integration }): React.JSX.Element | null {
  if (item.state === 'available') return null
  return (
    <span className={`ig-state is-${item.state}`}>
      {item.state === 'connected' && <Check />}
      {item.state === 'ready' && <Globe />}
      {STATE_LABEL[item.state]}
    </span>
  )
}

const AUTH_LABEL: Record<Integration['auth'], string> = {
  oauth: 'Sign in',
  api_key: 'API key',
  none: 'No account',
  custom: 'Own OAuth app'
}

interface CardProps {
  item: Integration
  base: string | null
  agents: AgentSummary[]
  usable: boolean
  pending: Pending | undefined
  onOpen: () => void
  onConnect: () => void
  onCancel: () => void
}

function Card({
  item,
  base,
  agents,
  usable,
  pending,
  onOpen,
  onConnect,
  onCancel
}: CardProps): React.JSX.Element {
  const users = agents.filter((a) => item.agents.includes(a.id))
  const live = item.state === 'connected' || item.state === 'ready'
  return (
    <article
      className={`ig-card is-${item.state}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen()
      }}
    >
      <div className="ig-card-head">
        <Logo slug={item.slug} name={item.name} base={base} size={34} />
        <div className="ig-card-title">
          <h3>
            {item.name}
            {live && <span className="ig-dot" title={STATE_LABEL[item.state]} />}
          </h3>
          <span>
            {item.tools ? `${item.tools} tools · ` : ''}
            {AUTH_LABEL[item.auth]}
          </span>
        </div>
        <div className="ig-card-action" onClick={(e) => e.stopPropagation()}>
          {pending ? (
            <button className="ig-connect is-waiting" onClick={onCancel} title="Stop waiting for the sign-in">
              <span className="spinner is-small" /> Waiting
            </button>
          ) : live ? (
            <button className="ig-connect is-live" onClick={onOpen}>
              {item.state === 'connected' ? (
                <>
                  <Check /> Connected
                </>
              ) : (
                'Ready'
              )}
            </button>
          ) : (
            <button className="ig-connect" disabled={!usable} onClick={onConnect}>
              {item.state === 'expired' ? 'Reconnect' : 'Connect'}
            </button>
          )}
        </div>
      </div>
      <p className="ig-card-desc">{item.description}</p>
      <div className="ig-card-foot">
        <AgentStack agents={users} />
        <ArrowUpRight className="ig-card-arrow" />
      </div>
    </article>
  )
}

function AgentStack({ agents }: { agents: AgentSummary[] }): React.JSX.Element {
  if (agents.length === 0) return <span className="ig-agents is-none">Not used by any agent yet</span>
  const names = agents.map((a) => a.name)
  return (
    <span className="ig-agents" title={names.join(', ')}>
      <span className="ig-agents-faces">
        {agents.slice(0, 3).map((a) => (
          <AgentAvatar key={a.id} agent={a} size={20} />
        ))}
      </span>
      <span className="ig-agents-names">
        {names.slice(0, 2).join(', ')}
        {names.length > 2 && ` +${names.length - 2}`}
      </span>
    </span>
  )
}

const HOW: Record<Integration['auth'], (name: string) => string> = {
  oauth: (name) =>
    `You sign in with ${name} directly. Polly never sees your password, and you can disconnect at any time.`,
  api_key: (name) =>
    `You paste a ${name} API key on a secure Composio page. The key is kept by Composio, not on this machine.`,
  none: () => 'No account needed. Agents you allow can use it straight away.',
  custom: (name) =>
    `${name} has no shared sign-in. Create an auth config for it with your own OAuth app in the Composio dashboard, then connect here.`
}

function Detail({
  item,
  base,
  agents,
  usable,
  category,
  pending,
  note,
  onClose,
  onConnect,
  onCancel,
  onDisconnect,
  onToggle
}: {
  item: Integration
  base: string | null
  agents: AgentSummary[]
  usable: boolean
  category: string
  pending: Pending | undefined
  note: string | undefined
  onClose: () => void
  onConnect: () => void
  onCancel: () => void
  onDisconnect: () => Promise<void>
  onToggle: (agentId: string, on: boolean) => void
}): React.JSX.Element {
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const since = item.connected_at
    ? new Date(item.connected_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null

  return (
    <div className="ig-scrim" onClick={onClose}>
      <aside
        className="ig-detail"
        role="dialog"
        aria-label={item.name}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="icon-btn ig-detail-close" title="Close" onClick={onClose}>
          <X />
        </button>

        <header className="ig-detail-head">
          <Logo slug={item.slug} name={item.name} base={base} size={48} />
          <div>
            <h2>{item.name}</h2>
            <span className="muted">
              {category}
              {item.tools ? ` · ${item.tools} tools` : ''}
            </span>
          </div>
        </header>
        <p className="ig-detail-desc">{item.description}.</p>

        <section className="ig-panel">
          <div className="ig-panel-head">
            <h3>Connection</h3>
            <StateBadge item={item} />
          </div>
          <p className="muted">{HOW[item.auth](item.name)}</p>
          {since && item.state === 'connected' && <p className="muted">Connected on {since}.</p>}

          {pending ? (
            <div className="ig-actions">
              <span className="ig-waiting">
                <span className="spinner is-small" /> Waiting for you to finish in the browser…
              </span>
              {pending.url && (
                <a className="btn btn-sm" href={pending.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open the page again
                </a>
              )}
              <button className="btn btn-sm btn-ghost" onClick={onCancel}>
                Cancel
              </button>
            </div>
          ) : item.state === 'connected' ? (
            <div className="ig-actions">
              <button
                className="btn btn-sm btn-danger"
                disabled={removing}
                onClick={() => {
                  setRemoving(true)
                  void onDisconnect().finally(() => setRemoving(false))
                }}
              >
                <Unplug /> {removing ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          ) : item.state !== 'ready' ? (
            <div className="ig-actions">
              <button className="btn btn-primary" disabled={!usable} onClick={onConnect}>
                <Plus /> {item.state === 'expired' ? 'Reconnect' : 'Connect'} {item.name}
              </button>
            </div>
          ) : null}
          {note && <p className="post-error">{note}</p>}
        </section>

        <section className="ig-panel">
          <div className="ig-panel-head">
            <h3>Agents that can use it</h3>
            <span className="muted">
              {item.agents.length} of {agents.length}
            </span>
          </div>
          {item.state === 'available' && (
            <p className="muted">Agents get these tools as soon as the account is connected.</p>
          )}
          <ul className="ig-agent-list">
            {agents.map((a) => (
              <li key={a.id}>
                <label>
                  <AgentAvatar agent={a} size={30} />
                  <span>
                    <b>{a.name}</b>
                    <span>{a.tagline}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={item.agents.includes(a.id)}
                    onChange={(e) => onToggle(a.id, e.target.checked)}
                  />
                </label>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  )
}
