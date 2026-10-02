import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FileContent, Session, TreeNode } from '../../../shared/contracts'
import { api } from '../api'
import { useCoder } from '../store/coder'
import { Popover } from './Composer'
import { relativeTime } from './toolMeta'

export function ProjectRail({ onOpenFolder }: { onOpenFolder: () => void }): React.JSX.Element {
  const projects = useCoder((s) => s.projects)
  const projectId = useCoder((s) => s.projectId)
  const selectProject = useCoder((s) => s.selectProject)
  const removeProject = useCoder((s) => s.removeProject)
  const newSession = useCoder((s) => s.newSession)
  const [open, setOpen] = useState(false)
  const project = projects.find((p) => p.id === projectId)

  return (
    <aside className="rail">
      <Popover
        open={open}
        onOpenChange={setOpen}
        placement="bottom"
        trigger={
          <button className="project-switch" onClick={() => setOpen(!open)}>
            <span className="project-icon">
              <FolderOpen />
            </span>
            <span className="project-name">
              <b>{project?.name ?? 'No project'}</b>
              <span title={project?.path}>{project ? shortPath(project.path) : 'Open a folder'}</span>
            </span>
            <ChevronDown className="chip-chev" />
          </button>
        }
      >
        <div className="menu menu-projects">
          <div className="menu-label">Projects</div>
          {projects.map((p) => (
            <div key={p.id} className={p.id === projectId ? 'menu-item is-active' : 'menu-item'}>
              <button
                className="menu-text"
                onClick={() => {
                  setOpen(false)
                  void selectProject(p.id)
                }}
              >
                <b>{p.name}</b>
                <span>{shortPath(p.path)}</span>
              </button>
              <button
                className="icon-btn"
                title="Forget this project (the folder is not touched)"
                onClick={() => void removeProject(p.id)}
              >
                <X />
              </button>
            </div>
          ))}
          <button
            className="menu-item menu-action"
            onClick={() => {
              setOpen(false)
              onOpenFolder()
            }}
          >
            <FolderPlus /> Open folder…
          </button>
        </div>
      </Popover>

      <button className="new-session" disabled={!project} onClick={() => void newSession()}>
        <Plus /> New session
      </button>

      <SessionList />
      {project && <FileTree projectId={project.id} />}
    </aside>
  )
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function SessionList(): React.JSX.Element {
  const sessions = useCoder((s) => s.sessions)
  const sessionId = useCoder((s) => s.sessionId)
  const openSession = useCoder((s) => s.openSession)
  const deleteSession = useCoder((s) => s.deleteSession)

  return (
    <div className="rail-section sessions">
      <div className="rail-label">Sessions</div>
      {sessions.length === 0 && <div className="rail-empty">No sessions yet.</div>}
      {sessions.map((s) => (
        <div key={s.id} className={s.id === sessionId ? 'session-row is-active' : 'session-row'}>
          <button className="session-main" onClick={() => void openSession(s.id)}>
            <StatusDot session={s} />
            <span className="session-title">{s.title || 'New session'}</span>
            <span className="session-time">{relativeTime(s.updated_at)}</span>
          </button>
          <button
            className="icon-btn session-delete"
            title="Delete session"
            onClick={() => {
              if (window.confirm('Delete this session? Changes it made to files stay as they are.'))
                void deleteSession(s.id)
            }}
          >
            <Trash2 />
          </button>
        </div>
      ))}
    </div>
  )
}

export function StatusDot({ session }: { session: Session }): React.JSX.Element {
  const title = {
    idle: 'Idle',
    running: 'Working',
    awaiting_approval: 'Waiting for your approval',
    error: 'Stopped with an error'
  }[session.status]
  if (session.status === 'idle') return <MessageSquare className="session-icon" />
  return <span className={`session-dot is-${session.status}`} title={title} />
}

// ---------- file tree ----------

function FileTree({ projectId }: { projectId: string }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [peek, setPeek] = useState<FileContent | null>(null)
  const changes = useCoder((s) => s.changes)
  const run = useCoder((s) => s.run)
  // Reload the tree when a run ends, since files may have appeared.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (run === 'idle') setVersion((v) => v + 1)
  }, [run, changes.length])

  const changed = new Map(changes.map((c) => [c.path, c.kind]))

  return (
    <div className={open ? 'rail-section tree-section is-open' : 'rail-section tree-section'}>
      <button className="rail-label rail-toggle" onClick={() => setOpen(!open)}>
        <ChevronRight className={open ? 'chev is-open' : 'chev'} /> Files
      </button>
      {open && (
        <div className="tree">
          <TreeLevel
            key={`${projectId}-${version}`}
            projectId={projectId}
            path=""
            depth={0}
            changed={changed}
            onPeek={(path) => void api.projects.file(projectId, path).then((r) => r.ok && setPeek(r.data))}
          />
        </div>
      )}
      {peek && <FilePeek file={peek} onClose={() => setPeek(null)} />}
    </div>
  )
}

function TreeLevel({
  projectId,
  path,
  depth,
  changed,
  onPeek
}: {
  projectId: string
  path: string
  depth: number
  changed: Map<string, string>
  onPeek: (path: string) => void
}): React.JSX.Element {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null)
  const load = useCallback(async () => {
    const res = await api.projects.tree(projectId, path, 1)
    setNodes(res.ok ? res.data : [])
  }, [projectId, path])
  useEffect(() => {
    void load()
  }, [load])

  if (nodes === null) return <div className="tree-loading" style={{ paddingLeft: 12 + depth * 12 }} />
  return (
    <>
      {nodes.map((n) =>
        n.kind === 'dir' ? (
          <TreeDir key={n.path} node={n} projectId={projectId} depth={depth} changed={changed} onPeek={onPeek} />
        ) : (
          <button
            key={n.path}
            className={`tree-row is-file${changed.has(n.path) ? ` is-${changed.get(n.path)}` : ''}`}
            style={{ paddingLeft: 22 + depth * 12 }}
            onClick={() => onPeek(n.path)}
            title={n.path}
          >
            <File />
            <span>{n.name}</span>
          </button>
        )
      )}
    </>
  )
}

function TreeDir({
  node,
  projectId,
  depth,
  changed,
  onPeek
}: {
  node: TreeNode
  projectId: string
  depth: number
  changed: Map<string, string>
  onPeek: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const touched = [...changed.keys()].some((p) => p.startsWith(`${node.path}/`))
  return (
    <>
      <button
        className={`tree-row is-dir${touched ? ' is-touched' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={open ? 'chev is-open' : 'chev'} />
        <Folder />
        <span>{node.name}</span>
      </button>
      {open && (
        <TreeLevel projectId={projectId} path={node.path} depth={depth + 1} changed={changed} onPeek={onPeek} />
      )}
    </>
  )
}

function FilePeek({ file, onClose }: { file: FileContent; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const lines = file.content.split('\n')
  return (
    <div className="peek-backdrop" onMouseDown={onClose}>
      <div className="peek" onMouseDown={(e) => e.stopPropagation()}>
        <div className="peek-head">
          <File />
          <code>{file.path}</code>
          <span className="muted">
            {lines.length} lines{file.truncated ? ' · truncated' : ''}
          </span>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X />
          </button>
        </div>
        <pre className="peek-body">
          {lines.map((l, i) => (
            <div key={i} className="peek-line">
              <span className="peek-no">{i + 1}</span>
              <span>{l || ' '}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
