import {
  Bot,
  CodeXml,
  GitPullRequest,
  House,
  Monitor,
  Plug,
  Settings as Cog,
  Telescope
} from 'lucide-react'
import type { ServerState } from '../App'
import mark from '../assets/polly-mark.svg'

export const SECTIONS = [
  'Home',
  'Coder',
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
  Research: <Telescope />,
  Review: <GitPullRequest />,
  Agents: <Bot />,
  Computers: <Monitor />,
  Integrations: <Plug />,
  Settings: <Cog />
}

interface Props {
  section: Section
  onSelect: (s: Section) => void
  server: ServerState
  onRecheck: () => void
}

export function Sidebar({ section, onSelect, server, onRecheck }: Props): React.JSX.Element {
  const item = (s: Section): React.JSX.Element => (
    <button
      key={s}
      className={s === section ? 'nav-item is-active' : 'nav-item'}
      onClick={() => onSelect(s)}
    >
      {ICONS[s]}
      {s}
    </button>
  )

  const health = server.health
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-mark" src={mark} alt="" />
        <span className="brand-name">Polly</span>
      </div>
      <nav>{SECTIONS.map(item)}</nav>
      <div className="sidebar-foot">
        <nav>{item('Settings')}</nav>
        <div className="runtime" title={server.error ?? undefined}>
          <span className={health ? 'dot dot-ok' : 'dot dot-down'} />
          {server.checking && !health ? 'Connecting…' : health ? 'Agent server' : 'Server offline'}
        </div>
        {health && (
          <div className="runtime">
            <span className={health.model.configured ? 'dot dot-ok' : 'dot dot-warn'} />
            {health.model.configured ? health.model.provider : 'No model key'}
          </div>
        )}
        <button className="runtime-recheck" onClick={onRecheck} disabled={server.checking}>
          {server.checking ? 'Checking…' : 'Recheck'}
        </button>
      </div>
    </aside>
  )
}
