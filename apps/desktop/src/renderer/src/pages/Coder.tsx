import {
  ChevronDown,
  CircleAlert,
  Folder,
  FolderOpen,
  GitBranch,
  Laptop,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  SquareTerminal,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSummary, Project } from '../../../shared/contracts'
import { Composer, Popover } from '../coder/Composer'
import { Inspector } from '../coder/Inspector'
import { ProjectMenu, ProjectRail, shortPath } from '../coder/ProjectRail'
import { Transcript } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Workspace } from '../components/Splitter'
import { useCoder } from '../store/coder'

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function Coder({ agent }: { agent: AgentSummary | undefined }): React.JSX.Element {
  const boot = useCoder((s) => s.boot)
  const openFolder = useCoder((s) => s.openFolder)
  const projectId = useCoder((s) => s.projectId)
  const projects = useCoder((s) => s.projects)
  const items = useCoder((s) => s.items)
  const session = useCoder((s) => s.session)
  const run = useCoder((s) => s.run)
  const error = useCoder((s) => s.error)
  const clearError = useCoder((s) => s.clearError)
  const inspector = useCoder((s) => s.panelOpen)
  const setInspector = useCoder((s) => s.setPanelOpen)
  const [askPath, setAskPath] = useState(false)

  useEffect(() => {
    void boot()
  }, [boot])

  const pickFolder = async (): Promise<void> => {
    if (window.polly?.pickFolder) {
      const path = await window.polly.pickFolder()
      if (path) await openFolder(path)
    } else {
      setAskPath(true)
    }
  }

  const project = projects.find((p) => p.id === projectId)
  // A new session: the prompt sits centre stage until the first message.
  const hero = !!project && items.length === 0

  // When the first message goes out, the box glides from the centre to its
  // place at the bottom: note where it was, then animate from there (FLIP).
  const stage = useRef<HTMLDivElement>(null)
  const from = useRef<DOMRect | null>(null)
  const capture = (): void => {
    from.current = stage.current?.querySelector('.composer-box')?.getBoundingClientRect() ?? null
  }
  useLayoutEffect(() => {
    const start = from.current
    if (hero || !start) return
    from.current = null
    const box = stage.current?.querySelector<HTMLElement>('.composer-box')
    if (!box || reducedMotion()) return
    const end = box.getBoundingClientRect()
    const dx = start.left - end.left
    const dy = start.top - end.top
    if (Math.abs(dy) < 2) return
    box.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 560,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    })
  }, [hero])

  return (
    <Workspace
      rail={<ProjectRail onOpenFolder={() => void pickFolder()} />}
      panel={inspector ? <Inspector /> : null}
    >
      <section className={hero ? 'chat is-empty' : 'chat'}>
        <header className="chat-head">
          {agent && <AgentAvatar agent={agent} size={22} active={run === 'running'} />}
          <div className="chat-title">
            <b>{session?.title || (project ? 'New session' : 'Coder')}</b>
            {project && (
              <span>
                {project.name}
                {project.branch && (
                  <>
                    <GitBranch />
                    {project.branch}
                  </>
                )}
              </span>
            )}
          </div>
          <span className={`run-state is-${run}`}>
            {run === 'running' ? 'Working' : run === 'awaiting_approval' ? 'Needs approval' : ''}
          </span>
          <button
            className="icon-btn"
            title={inspector ? 'Hide panel' : 'Show panel'}
            onClick={() => setInspector(!inspector)}
          >
            {inspector ? <PanelRightClose /> : <PanelRightOpen />}
          </button>
        </header>

        {error && (
          <div className="banner is-error">
            <CircleAlert />
            <span>{error}</span>
            <button className="icon-btn" onClick={clearError} title="Dismiss">
              <X />
            </button>
          </div>
        )}

        {!project ? <Welcome onOpen={() => void pickFolder()} /> : !hero && <Transcript agent={agent} />}

        {project && (
          <div className="composer-stage" ref={stage}>
            {hero && (
              <div className="hero">
                {agent && (
                  <div className="hero-bot" aria-hidden>
                    <AgentAvatar agent={agent} size={104} bare motion="medium" />
                    <span className="hero-bot-shadow" />
                  </div>
                )}
                <h2>
                  What should we build in <em>{project.name}</em>?
                </h2>
              </div>
            )}
            <Composer
              placeholder={hero ? 'Describe a change, a bug, or a question about the code' : undefined}
              onBeforeSend={hero ? capture : undefined}
              above={hero ? <Where project={project} onOpenFolder={() => void pickFolder()} /> : undefined}
              below={hero ? <Checkout project={project} /> : undefined}
            />
          </div>
        )}
      </section>

      {askPath && (
        <PathDialog
          onClose={() => setAskPath(false)}
          onSubmit={async (path) => {
            if (await openFolder(path)) setAskPath(false)
          }}
        />
      )}
    </Workspace>
  )
}

function Welcome({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <div className="coder-welcome">
      <div className="welcome-mark">
        <SquareTerminal />
      </div>
      <h2>
        Code with <em>Coder</em>
      </h2>
      <p>
        Open a project folder. Coder reads it, plans the change, edits files and runs your tests —
        asking before anything you have not trusted it with.
      </p>
      <button className="btn btn-primary btn-lg" onClick={onOpen}>
        <FolderOpen /> Open a project folder
      </button>
      <div className="welcome-points">
        <span>
          <ShieldCheck /> Works only inside the folder you pick
        </span>
        <span>Runs on NVIDIA Nemotron via Nebius Token Factory</span>
      </div>
    </div>
  )
}

/** Where the session will run: this machine, and which project. */
function Where({ project, onOpenFolder }: { project: Project; onOpenFolder: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <span className="ctx-chip is-static" title="Runs on this machine">
        <Laptop />
        <span>{project.host || 'This computer'}</span>
      </span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        placement="bottom"
        align="end"
        trigger={
          <button className="ctx-chip" title={project.path} onClick={() => setOpen(!open)}>
            <Folder />
            <span>{project.name}</span>
            <ChevronDown className="chip-chev" />
          </button>
        }
      >
        <ProjectMenu onClose={() => setOpen(false)} onOpenFolder={onOpenFolder} />
      </Popover>
    </>
  )
}

/** "…/code/asset-flow": enough of a path to recognise it. */
function tailPath(path: string): string {
  const short = shortPath(path)
  const parts = short.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : short
}

/** The working copy the Coder will change. */
function Checkout({ project }: { project: Project }): React.JSX.Element {
  return (
    <>
      <span className="ctx-chip is-static" title={shortPath(project.path)}>
        <FolderOpen />
        <span>{tailPath(project.path)}</span>
      </span>
      {project.branch && (
        <span className="ctx-chip is-static" title="Current branch">
          <GitBranch />
          <span>{project.branch}</span>
        </span>
      )}
    </>
  )
}

function PathDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void
  onSubmit: (path: string) => Promise<void>
}): React.JSX.Element {
  const [path, setPath] = useState('')
  return (
    <div className="peek-backdrop" onMouseDown={onClose}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (path.trim()) void onSubmit(path.trim())
        }}
      >
        <h3>Open a project folder</h3>
        <p className="muted">Paste the absolute path of a folder on this machine.</p>
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/you/code/my-project"
        />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!path.trim()}>
            Open
          </button>
        </div>
      </form>
    </div>
  )
}
