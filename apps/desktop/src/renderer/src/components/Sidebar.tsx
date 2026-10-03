import {
  Bot,
  CodeXml,
  GitPullRequest,
  House,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Plug,
  RotateCw,
  Settings as Cog,
  Telescope
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ServerState } from '../App'
import mark from '../assets/polly-mark.svg'
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

const ICONS: Record<Section, React.JSX.Element> = {
  Home: <House />,
  Coder: <CodeXml />,
  Design: <PenTool />,
  Research: <Telescope />,
  Review: <GitPullRequest />,
  Agents: <Bot />,
  Computers: <Monitor />,
  Integrations: <Plug />,
  Settings: <Cog />
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

interface Props {
  section: Section
  onSelect: (s: Section) => void
  server: ServerState
  onRecheck: () => void
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({
  section,
  onSelect,
  server,
  onRecheck,
  collapsed,
  onToggle
}: Props): React.JSX.Element {
  const [art] = useStageArt()
  const item = (s: Section): React.JSX.Element => (
    <button
      key={s}
      className={s === section ? 'nav-item is-active' : 'nav-item'}
      onClick={() => onSelect(s)}
      title={collapsed ? s : undefined}
      aria-label={s}
    >
      {ICONS[s]}
      <span className="nav-label">{s}</span>
    </button>
  )

  const health = server.health
  const status = server.checking && !health ? 'Connecting…' : health ? 'Agent server' : 'Server offline'
  const model = health ? (health.model.configured ? health.model.provider : 'No model key') : null
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
      <nav>{SECTIONS.map(item)}</nav>
      <div className="sidebar-foot">
        <nav>{item('Settings')}</nav>
        {collapsed ? (
          <button
            className="runtime-mini"
            onClick={onRecheck}
            disabled={server.checking}
            title={`${status}${model ? ` · ${model}` : ''}${server.error ? `\n${server.error}` : ''}\nClick to recheck`}
          >
            <span
              className={
                !health ? 'dot dot-down' : health.model.configured ? 'dot dot-ok' : 'dot dot-warn'
              }
            />
          </button>
        ) : (
          <>
            <div className="runtime" title={server.error ?? undefined}>
              <span className={health ? 'dot dot-ok' : 'dot dot-down'} />
              {status}
              <button
                className="runtime-recheck"
                onClick={onRecheck}
                disabled={server.checking}
                title="Recheck"
              >
                <RotateCw className={server.checking ? 'is-spinning' : ''} />
              </button>
            </div>
            {health && (
              <div className="runtime">
                <span className={health.model.configured ? 'dot dot-ok' : 'dot dot-warn'} />
                {model}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
