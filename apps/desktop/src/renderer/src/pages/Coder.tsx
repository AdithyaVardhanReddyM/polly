import {
  CircleAlert,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  SquareTerminal,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { Composer } from '../coder/Composer'
import { Inspector } from '../coder/Inspector'
import { ProjectRail } from '../coder/ProjectRail'
import { Transcript } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { useCoder } from '../store/coder'

const STARTERS = [
  'Explain how this project is structured and where the entry points are',
  'Find and fix the failing tests',
  'Add input validation to the main API handlers',
  'Review the code for bugs and propose fixes'
]

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
  const [inspector, setInspector] = useState(true)
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
  const empty = items.length === 0

  return (
    <div className={inspector ? 'coder' : 'coder is-wide'}>
      <ProjectRail onOpenFolder={() => void pickFolder()} />

      <section className="chat">
        <header className="chat-head">
          {agent && <AgentAvatar agent={agent} size={24} active={run === 'running'} />}
          <div className="chat-title">
            <b>{session?.title || (project ? 'New session' : 'Coder')}</b>
            {project && <span>{project.name}</span>}
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

        {!project ? (
          <Welcome onOpen={() => void pickFolder()} />
        ) : empty ? (
          <Starters />
        ) : (
          <Transcript />
        )}

        <Composer />
      </section>

      {inspector && <Inspector />}

      {askPath && (
        <PathDialog
          onClose={() => setAskPath(false)}
          onSubmit={async (path) => {
            if (await openFolder(path)) setAskPath(false)
          }}
        />
      )}
    </div>
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

function Starters(): React.JSX.Element {
  const send = useCoder((s) => s.send)
  const run = useCoder((s) => s.run)
  return (
    <div className="coder-starters">
      <h2>
        What should we <em>build?</em>
      </h2>
      <div className="starter-grid">
        {STARTERS.map((s) => (
          <button key={s} className="starter" disabled={run !== 'idle'} onClick={() => void send(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
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
