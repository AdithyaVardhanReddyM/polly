import {
  ArrowLeft,
  ArrowUpRight,
  Brain,
  Check,
  ChevronsUpDown,
  CircleAlert,
  Globe,
  Plug,
  Plus,
  Shuffle,
  Sparkles,
  SquareTerminal,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentFields, AgentSummary, Integration } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { api, serverUrl } from '../api'
import { ModelMenu, Popover } from '../coder/Composer'
import { ModelLogo } from '../coder/icons'
import { formatTokens } from '../coder/toolMeta'
import { AgentAvatar } from '../components/AgentAvatar'
import { MAX_TEAMMATES } from '../components/Team'
import { drawBack, drawFront, faceCanvas, strapCanvas } from '../lanyard/badge'
import { describeModel, useModels } from '../store/models'
import { joinable, useRoster } from '../store/roster'
import { Logo } from './Integrations'

// three.js and the physics engine are only needed here: load them with the page.
const Lanyard = lazy(() => import('../lanyard/Lanyard'))

const BLANK: AgentFields = {
  name: '',
  tagline: '',
  description: '',
  system_prompt: '',
  model: '',
  search: true,
  sandbox: false,
  memory: true,
  avatar: {},
  integrations: [],
  teammates: []
}

/** Starting points for "Write it for me": a label and the sentence it fills in. */
const IDEAS: [string, string][] = [
  ['Data analyst', 'A data analyst that turns numbers and spreadsheets into clear charts'],
  ['Trip planner', 'A trip planner that builds day-by-day itineraries with current prices and opening hours'],
  ['Writing editor', 'An editor that tightens my drafts without changing my voice'],
  ['Study coach', 'A study coach that explains a topic, then quizzes me until I have it']
]

const newSeed = (): string => Math.random().toString(36).slice(2, 10)

interface Props {
  /** The agent being edited; null makes a new one. */
  agentId: string | null
  server: ServerState
  onClose: () => void
  /** After a save: the agent as the server now has it. */
  onSaved: (agent: AgentSummary) => void
  onDeleted: () => void
  onConnectApps: () => void
}

export function Builder({
  agentId,
  server,
  onClose,
  onSaved,
  onDeleted,
  onConnectApps
}: Props): React.JSX.Element {
  const [fields, setFields] = useState<AgentFields>(() => ({ ...BLANK, avatar: { seed: newSeed() } }))
  const [loading, setLoading] = useState(agentId !== null)
  const [idea, setIdea] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apps, setApps] = useState<Integration[]>([])
  const [base, setBase] = useState<string | null>(null)
  const models = useModels((s) => s.models)
  const loadModels = useModels((s) => s.load)
  const everyone = useRoster((s) => s.agents)
  // An agent hands work to others, never to itself.
  const mates = joinable(everyone).filter((a) => a.id !== agentId)

  const set = <K extends keyof AgentFields>(key: K, value: AgentFields[K]): void =>
    setFields((f) => ({ ...f, [key]: value }))

  useEffect(() => {
    void loadModels()
    void serverUrl().then(setBase)
    void api.integrations.status().then((res) => {
      if (res.ok) setApps(res.data.items)
    })
  }, [loadModels])

  useEffect(() => {
    if (!agentId) return
    let stale = false
    void api.custom.config(agentId).then((res) => {
      if (stale) return
      setLoading(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      const { id: _id, created_at: _c, updated_at: _u, ...rest } = res.data
      setFields(rest)
    })
    return () => {
      stale = true
    }
  }, [agentId])

  const h = server.health
  const searchReady = h?.search.configured ?? true
  const sandboxReady = h?.sandbox.configured ?? true
  const modelReady = h?.model.configured ?? true

  const defaultModel = models.find((m) => m.is_default)
  // The model the agent will run on: its own choice, or Polly's default.
  const picked = models.find((m) => m.id === fields.model) ?? defaultModel
  const modelLabel = fields.model
    ? describeModel(fields.model, models).label
    : (defaultModel?.label ?? 'Default model')

  // Apps the agent can use now come first; the rest can be allowed ahead of connecting.
  const usable = apps.filter((a) => a.state === 'connected' || a.state === 'ready')
  const chosenElsewhere = apps.filter(
    (a) => fields.integrations.includes(a.slug) && !usable.includes(a)
  )
  const shownApps = [...usable, ...chosenElsewhere]

  const abilities = [
    fields.search && 'Web search',
    fields.sandbox && 'Sandbox',
    fields.memory && 'Memory',
    fields.integrations.length > 0 &&
      `${fields.integrations.length} app${fields.integrations.length === 1 ? '' : 's'}`,
    fields.teammates.length > 0 &&
      `${fields.teammates.length} teammate${fields.teammates.length === 1 ? '' : 's'}`
  ].filter((x): x is string => !!x)

  const draft = async (): Promise<void> => {
    if (!idea.trim() || drafting) return
    setDrafting(true)
    setError(null)
    const res = await api.custom.draft(idea.trim())
    setDrafting(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setFields((f) => ({
      ...f,
      ...res.data,
      search: res.data.search && searchReady,
      sandbox: res.data.sandbox && sandboxReady
    }))
  }

  const save = async (): Promise<void> => {
    if (!fields.name.trim() || saving) return
    setSaving(true)
    setError(null)
    const body = { ...fields, name: fields.name.trim(), tagline: fields.tagline.trim() }
    const res = agentId ? await api.custom.update(agentId, body) : await api.custom.create(body)
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onSaved(res.data)
  }

  const remove = async (): Promise<void> => {
    if (!agentId) return
    if (!window.confirm(`Delete ${fields.name || 'this agent'} and its conversations?`)) return
    const res = await api.custom.remove(agentId)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onDeleted()
  }

  const toggleApp = (slug: string): void =>
    set(
      'integrations',
      fields.integrations.includes(slug)
        ? fields.integrations.filter((s) => s !== slug)
        : [...fields.integrations, slug]
    )

  const toggleMate = (id: string): void =>
    set(
      'teammates',
      fields.teammates.includes(id)
        ? fields.teammates.filter((m) => m !== id)
        : [...fields.teammates, id]
    )

  const title = fields.name.trim() || (agentId ? 'Agent' : 'New agent')
  const canSave = !!fields.name.trim() && !saving && !loading

  return (
    <div className="builder">
      <div className="builder-form">
        <header className="builder-head">
          <button className="icon-btn" onClick={onClose} title="Back to agents">
            <ArrowLeft />
          </button>
          <nav className="builder-crumbs" aria-label="Breadcrumb">
            <button className="link" onClick={onClose}>
              Agents
            </button>
            <span aria-hidden>/</span>
            <b>{title}</b>
          </nav>
          <span className="composer-spacer" />
          {agentId && (
            <button className="btn builder-delete" onClick={() => void remove()}>
              <Trash2 /> Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
            {saving ? 'Saving…' : agentId ? 'Save changes' : 'Create agent'}
          </button>
        </header>

        {error && (
          <div className="banner is-error">
            <CircleAlert />
            <span>{error}</span>
            <button className="icon-btn" onClick={() => setError(null)} title="Dismiss">
              <X />
            </button>
          </div>
        )}

        <div className="builder-body">
          <div className="builder-intro">
            <h1>{agentId ? `Edit ${title}` : 'New agent'}</h1>
            <p>Give it a job, a model and the tools to do it.</p>
          </div>

          <section className={drafting ? 'idea is-drafting' : 'idea'}>
            <textarea
              rows={2}
              value={idea}
              aria-label="Describe the agent you want"
              placeholder="Describe the agent you want, in a sentence…"
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void draft()
                }
              }}
            />
            <div className="idea-bar">
              <div className="idea-chips">
                {IDEAS.map(([label, sentence]) => (
                  <button key={label} onClick={() => setIdea(sentence)}>
                    {label}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-primary"
                disabled={!idea.trim() || drafting || !modelReady}
                title={modelReady ? 'Nemotron drafts the name, tagline and instructions' : 'Needs NEBIUS_API_KEY in .env'}
                onClick={() => void draft()}
              >
                <Sparkles /> {drafting ? 'Writing…' : 'Write it for me'}
              </button>
            </div>
          </section>

          <Step title="Identity" hint="Who it is, at a glance.">
            <div className="field-grid">
              <div className="field">
                <label htmlFor="builder-name">
                  Name <Count value={fields.name} max={40} />
                </label>
                <input
                  id="builder-name"
                  className="is-name"
                  value={fields.name}
                  maxLength={40}
                  placeholder="Analyst"
                  autoFocus={!agentId}
                  onChange={(e) => set('name', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="builder-tagline">
                  Tagline <Count value={fields.tagline} max={80} />
                </label>
                <input
                  id="builder-tagline"
                  value={fields.tagline}
                  maxLength={80}
                  placeholder="Turns data into clear charts"
                  onChange={(e) => set('tagline', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="builder-description">
                Description <span>Optional</span>
              </label>
              <textarea
                id="builder-description"
                rows={2}
                value={fields.description}
                maxLength={400}
                placeholder="What you give it and what you get back."
                onChange={(e) => set('description', e.target.value)}
              />
            </div>
          </Step>

          <Step title="Instructions" hint="How it should think, work and reply.">
            <div className="prompt-box">
              <textarea
                id="builder-prompt"
                aria-label="Instructions"
                rows={11}
                value={fields.system_prompt}
                maxLength={20000}
                placeholder={
                  'You are a data analyst. When the user gives you numbers or a file:\n1. Check what the data contains before analysing it.\n2. …'
                }
                onChange={(e) => set('system_prompt', e.target.value)}
              />
              <div className="prompt-foot">
                <span>Written to the agent as "you". Markdown works.</span>
                <span>{fields.system_prompt.length.toLocaleString()} characters</span>
              </div>
            </div>
          </Step>

          <Step title="Model" hint="The mind it runs on.">
            <Popover
              open={picking}
              onOpenChange={setPicking}
              placement="bottom"
              trigger={
                <button
                  className={picking ? 'model-field is-open' : 'model-field'}
                  aria-haspopup="listbox"
                  aria-expanded={picking}
                  onClick={() => setPicking(!picking)}
                >
                  {picked && <ModelLogo vendor={picked.vendor} model={picked.id} size={30} />}
                  <span className="menu-text">
                    <b>
                      {picked?.label ?? 'Choose a model'}
                      {!fields.model && <em className="badge">Default</em>}
                    </b>
                    {picked && (
                      <span>
                        {picked.vendor}
                        {picked.tokens_per_second
                          ? ` · ${Math.round(picked.tokens_per_second)} tok/s`
                          : ''}
                        {` · ${formatTokens(picked.context_window)} context`}
                        {picked.vision ? ' · Vision' : ''}
                      </span>
                    )}
                  </span>
                  <ChevronsUpDown />
                </button>
              }
            >
              <ModelMenu
                models={models}
                value={picked?.id ?? ''}
                onPick={(id) => {
                  setPicking(false)
                  // Polly's default is stored as "no choice", so the agent
                  // follows it if the default changes.
                  set('model', id === defaultModel?.id ? '' : id)
                }}
              />
            </Popover>
          </Step>

          <Step title="Abilities" hint="What it can do beyond talking.">
            <div className="abilities">
              <Ability
                tone="research"
                icon={<Globe />}
                title="Web search"
                detail="Searches the live web, reads the pages that matter and cites its sources."
                by="Tavily"
                missing={searchReady ? null : 'Needs TAVILY_API_KEY'}
                checked={fields.search}
                onChange={(on) => set('search', on)}
              />
              <Ability
                tone="coding"
                icon={<SquareTerminal />}
                title="Code sandbox"
                detail="Writes and runs Python in its own sandbox: analysis, charts and files."
                by="Nebius ConTree"
                missing={sandboxReady ? null : 'Needs NEBIUS_PROJECT_ID'}
                checked={fields.sandbox}
                onChange={(on) => set('sandbox', on)}
              />
              <Ability
                tone="custom"
                icon={<Brain />}
                title="Memory"
                detail="Knows what Polly remembers about you, and adds to it as you talk."
                by="Shared with every agent"
                missing={null}
                checked={fields.memory}
                onChange={(on) => set('memory', on)}
              />
            </div>
          </Step>

          <Step title="Apps" hint="Connected accounts it may act in.">
            {shownApps.length > 0 ? (
              <div className="app-grid">
                {shownApps.map((a) => {
                  const on = fields.integrations.includes(a.slug)
                  const live = a.state === 'connected' || a.state === 'ready'
                  return (
                    <button
                      key={a.slug}
                      className={on ? 'app-card is-on' : 'app-card'}
                      aria-pressed={on}
                      onClick={() => toggleApp(a.slug)}
                    >
                      <span className="ig-card-head">
                        <Logo slug={a.slug} name={a.name} base={base} size={30} />
                        <span className="ig-card-title">
                          <b>
                            {a.name}
                            {live && <span className="ig-dot" />}
                          </b>
                          <span>
                            {a.tools ? `${a.tools} tools` : live ? 'Connected' : 'Not connected'}
                          </span>
                        </span>
                        <span className={on ? 'ig-connect is-live' : 'ig-connect'}>
                          {on ? (
                            <>
                              <Check /> Added
                            </>
                          ) : (
                            <>
                              <Plus /> Add
                            </>
                          )}
                        </span>
                      </span>
                      <span className="app-card-desc">{a.description}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="app-empty">
                <Plug />
                <span>No apps are connected yet.</span>
              </div>
            )}
            <button className="link builder-link" onClick={onConnectApps}>
              Connect more apps <ArrowUpRight />
            </button>
          </Step>

          <Step title="Teammates" hint="Other agents it can hand work to.">
            {mates.length > 0 ? (
              <div className="app-grid">
                {mates.map((a) => {
                  const on = fields.teammates.includes(a.id)
                  return (
                    <button
                      key={a.id}
                      className={on ? 'app-card is-on' : 'app-card'}
                      aria-pressed={on}
                      disabled={!on && fields.teammates.length >= MAX_TEAMMATES}
                      onClick={() => toggleMate(a.id)}
                    >
                      <span className="ig-card-head">
                        <AgentAvatar agent={a} size={30} />
                        <span className="ig-card-title">
                          <b>{a.name}</b>
                          <span>{a.custom ? 'Your agent' : 'Built in'}</span>
                        </span>
                        <span className={on ? 'ig-connect is-live' : 'ig-connect'}>
                          {on ? (
                            <>
                              <Check /> Added
                            </>
                          ) : (
                            <>
                              <Plus /> Add
                            </>
                          )}
                        </span>
                      </span>
                      <span className="app-card-desc">{a.tagline || a.description}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="app-empty">
                <Users />
                <span>No other agents to call on yet.</span>
              </div>
            )}
            <p className="part-note">
              It decides when to ask a teammate, and the teammate remembers what it did earlier in
              the conversation.
            </p>
          </Step>
        </div>
      </div>

      <aside className="builder-stage">
        <Card
          name={fields.name}
          tagline={fields.tagline}
          avatar={fields.avatar}
          abilities={abilities}
          model={modelLabel}
        />
        <div className="builder-stage-foot">
          <button className="btn" onClick={() => set('avatar', { seed: newSeed() })}>
            <Shuffle /> Shuffle robot
          </button>
          <span>Drag the card</span>
        </div>
      </aside>
    </div>
  )
}

/** One part of the form: what it is on the left, its controls on the right. */
function Step({
  title,
  hint,
  children
}: {
  title: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="part">
      <div className="part-head">
        <h2>{title}</h2>
        <p>{hint}</p>
      </div>
      <div className="part-body">{children}</div>
    </section>
  )
}

function Count({ value, max }: { value: string; max: number }): React.JSX.Element | null {
  // Only once it matters: the last fifth of the room.
  if (value.length < max * 0.8) return null
  return (
    <span className="count">
      {value.length}/{max}
    </span>
  )
}

function Ability({
  tone,
  icon,
  title,
  detail,
  by,
  missing,
  checked,
  onChange
}: {
  /** Which of the app's colour families the icon takes. */
  tone: 'research' | 'coding' | 'custom'
  icon: React.JSX.Element
  title: string
  detail: string
  /** What provides it. */
  by: string
  /** Why it cannot be turned on, when it cannot. */
  missing: string | null
  checked: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  const disabled = !!missing && !checked
  return (
    <label className={`ability${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span className={`ability-icon is-${tone}`}>{icon}</span>
      <span className="ability-text">
        <span className="ability-title">
          <b>{title}</b>
          <span className={missing ? 'ability-by is-missing' : 'ability-by'}>{missing ?? by}</span>
        </span>
        <span className="ability-detail">{detail}</span>
      </span>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

interface CardProps {
  name: string
  tagline: string
  avatar: Record<string, string>
  abilities: string[]
  model: string
}

/** The agent's ID card on its lanyard, redrawn as the form changes. */
function Card(props: CardProps): React.JSX.Element {
  const front = useMemo(faceCanvas, [])
  const back = useMemo(faceCanvas, [])
  const [strap, setStrap] = useState<HTMLCanvasElement | null>(null)
  const [version, setVersion] = useState(0)
  const latest = useRef(0)
  const { name, tagline, avatar, model } = props
  const abilities = props.abilities.join('|')

  useEffect(() => {
    void strapCanvas().then(setStrap)
    void drawBack(back).then(() => setVersion((v) => v + 1))
  }, [back])

  useEffect(() => {
    const mine = ++latest.current
    // Typing redraws the card a moment after the last key, not on every one.
    const timer = window.setTimeout(() => {
      const badge = { name, tagline, avatar, model, abilities: abilities ? abilities.split('|') : [] }
      void drawFront(front, badge, () => latest.current !== mine).then((drawn) => {
        if (drawn) setVersion((v) => v + 1)
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [front, name, tagline, avatar, model, abilities])

  const flat = (
    <div className="builder-flat">
      <AgentAvatar agent={{ avatar, division: 'custom', name: name || 'New agent' }} size={120} />
      <b>{name || 'New agent'}</b>
      <span>{tagline}</span>
    </div>
  )

  if (!strap) return <div className="lanyard" />
  return (
    <Fallback flat={flat}>
      <Suspense fallback={<div className="lanyard" />}>
        <Lanyard front={front} back={back} strap={strap} version={version} />
      </Suspense>
    </Fallback>
  )
}

/** Without WebGL the card cannot be drawn in 3D: show the robot flat instead. */
class Fallback extends Component<
  { flat: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.flat : this.props.children
  }
}
