import {
  Bot,
  House,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings as Cog,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AgentSummary, Session } from '../../../shared/contracts'
import { api } from '../api'
import mark from '../assets/polly-mark.svg'
import { shortTime } from '../coder/toolMeta'
import { useDesign } from '../design/session'
import { useResearch, useReview } from '../store/agentSession'
import { useCoder } from '../store/coder'
import { AgentAvatar } from './AgentAvatar'
import { SidebarStage, useStageArt } from './StageArt'

export const SECTIONS = [
  'Home',
  'Coder',
  'Design',
  'Research',
  'Review',
  'Agents',
  'Computers',
  'Integrations'
] as const
export type Section = (typeof SECTIONS)[number] | 'Settings'

/** The pages in the sidebar's nav; every agent below it opens its own workspace. */
const NAV = ['Home', 'Agents', 'Integrations'] as const

const ICONS: Record<(typeof NAV)[number] | 'Settings', React.JSX.Element> = {
  Home: <House />,
  Agents: <Bot />,
  Integrations: <Plug />,
  Settings: <Cog />
}

/** Where each runnable agent lives. */
export const HOME_OF: Record<string, Section> = {
  coder: 'Coder',
  designer: 'Design',
  researcher: 'Research',
  'deep-research': 'Research',
  reviewer: 'Review'
}

const COLLAPSED = 'polly.sidebar.collapsed'

/** Whether the main sidebar is folded to icons; remembered, toggled with ⌘B. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED) === '1'
    } catch {
      return false
    }
  })
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED, c ? '0' : '1')
      } catch {
        /* storage can be unavailable */
      }
      return !c
    })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'b' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])
  return [collapsed, toggle]
}

/** What each agent is up to: 'running', 'awaiting_approval', or absent when idle. */
function useWorking(): Record<string, string> {
  const coder = useCoder((s) => s.run)
  const design = useDesign((s) => s.run)
  const review = useReview((s) => s.run)
  const research = useResearch((s) => s.run)
  const researching = useResearch((s) => s.session?.agent_id ?? s.agentId)
  const working: Record<string, string> = {}
  if (coder !== 'idle') working.coder = coder
  if (design !== 'idle') working.designer = design
  if (review !== 'idle') working.reviewer = review
  if (research !== 'idle') working[researching] = research
  return working
}

/** Each agent's most recent session, refetched as sessions start, finish or go. */
function useLatest(ids: string[], working: Record<string, string>): Record<string, Session> {
  const [latest, setLatest] = useState<Record<string, Session>>({})
  const coder = useCoder((s) => s.sessions)
  const design = useDesign((s) => s.sessions)
  const review = useReview((s) => s.sessions)
  const research = useResearch((s) => s.sessions)
  const key = ids.join(',')
  const busy = Object.keys(working).join(',')

  useEffect(() => {
    if (!key) return
    let stale = false
    const wanted = key.split(',')
    void Promise.all(wanted.map((id) => api.sessions.list(id))).then((lists) => {
      if (stale) return
      const next: Record<string, Session> = {}
      lists.forEach((r, i) => {
        if (r.ok && r.data[0]) next[wanted[i]] = r.data[0]
      })
      setLatest(next)
    })
    return () => {
      stale = true
    }
  }, [key, busy, coder, design, review, research])

  return latest
}

interface Props {
  section: Section
  onSelect: (s: Section) => void
  agents: AgentSummary[]
  /** Open an agent's workspace, where its last session is waiting. */
  onChat: (id: string) => void
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({
  section,
  onSelect,
  agents,
  onChat,
  collapsed,
  onToggle
}: Props): React.JSX.Element {
  const [art] = useStageArt()
  const item = (s: keyof typeof ICONS): React.JSX.Element => (
    <button
      key={s}
      className={s === section ? 'nav-item is-active' : 'nav-item'}
      onClick={() => onSelect(s)}
      title={collapsed ? s : undefined}
      aria-label={s}
      aria-current={s === section ? 'page' : undefined}
    >
      {ICONS[s]}
      <span className="nav-label">{s}</span>
    </button>
  )

  const team = agents.filter((a) => a.status === 'ready' && HOME_OF[a.id])
  const working = useWorking()
  const latest = useLatest(
    team.map((a) => a.id),
    working
  )
  const researching = useResearch((s) => s.session?.agent_id ?? s.agentId)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? team.filter((a) =>
        [a.name, a.tagline, a.description, latest[a.id]?.title ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle)
      )
    : team

  const chat = (a: AgentSummary): React.JSX.Element => {
    const home = HOME_OF[a.id]
    const active = home === section && (home !== 'Research' || researching === a.id)
    const state = working[a.id]
    const last = latest[a.id]
    return (
      <button
        key={a.id}
        className={`buddy${active ? ' is-active' : ''}${state ? ' is-working' : ''}`}
        onClick={() => onChat(a.id)}
        title={collapsed ? a.name : undefined}
        aria-label={a.name}
        aria-current={active ? 'page' : undefined}
      >
        <span className="buddy-avatar">
          <AgentAvatar agent={a} size={44} bare motion={state ? 'medium' : 'slow'} />
          {state && <span className="buddy-live" />}
        </span>
        <span className="buddy-body">
          <span className="buddy-line">
            <span className="buddy-name">{a.name}</span>
            {(state || last) && (
              <span className="buddy-time">{state ? 'now' : shortTime(last.updated_at)}</span>
            )}
          </span>
          <span className="buddy-sub">
            {state === 'running' && (
              <span className="buddy-typing" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            )}
            <span>
              {state === 'awaiting_approval'
                ? 'Needs your approval'
                : state
                  ? 'Working'
                  : last?.title || a.tagline}
            </span>
          </span>
        </span>
      </button>
    )
  }

  const toggle = (
    <button
      className="sidebar-toggle"
      onClick={onToggle}
      title={collapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
    </button>
  )

  return (
    <aside
      className={`sidebar${collapsed ? ' is-collapsed' : ''}${art !== 'off' ? ' has-stage' : ''}`}
    >
      {art !== 'off' && <SidebarStage art={art} />}
      <div className="sidebar-top">{toggle}</div>
      <div className="brand">
        <img className="brand-mark" src={mark} alt="" />
        <span className="brand-name">Polly</span>
      </div>
      <nav>{NAV.map(item)}</nav>
      {team.length > 0 && (
        <div className="buddies">
          <div className="buddies-head">Your agents</div>
          <label className="buddy-search">
            <Search />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
                if (e.key === 'Enter' && shown[0]) onChat(shown[0].id)
              }}
              placeholder="Search agents"
              aria-label="Search agents"
              spellCheck={false}
            />
            {query && (
              <button
                className="buddy-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X />
              </button>
            )}
          </label>
          <div className="buddies-list">
            {shown.map(chat)}
            {shown.length === 0 && (
              <div className="buddies-empty">No agents match “{query.trim()}”</div>
            )}
          </div>
        </div>
      )}
      <div className="sidebar-foot">
        <nav>{item('Settings')}</nav>
      </div>
    </aside>
  )
}
