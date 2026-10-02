import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Folder,
  FolderPlus,
  GitBranch,
  Laptop,
  RotateCw,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Session, TreeNode } from '../../../shared/contracts'
import { api } from '../api'
import { useCoder } from '../store/coder'
import { describeModel, useModels } from '../store/models'
import { Popover } from './Composer'
import { FileIcon, FolderIcon, ModelLogo } from './icons'
import { shortTime } from './toolMeta'

export function ProjectRail({ onOpenFolder }: { onOpenFolder: () => void }): React.JSX.Element {
  const projects = useCoder((s) => s.projects)
  const projectId = useCoder((s) => s.projectId)
  const newSession = useCoder((s) => s.newSession)
  const [open, setOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(true)
  const project = projects.find((p) => p.id === projectId)

  return (
    <aside className="rail">
      <header className="rail-head">
        <Popover
          open={open}
          onOpenChange={setOpen}
          placement="bottom"
          trigger={
            <button
              className="project-switch"
              onClick={() => setOpen(!open)}
              title={project?.path ?? 'Open a project folder'}
            >
              <Folder className="project-glyph" />
              <span className="project-name">{project?.name ?? 'No project'}</span>
              {project?.host && <span className="project-host">@ {project.host}</span>}
              <ChevronDown className="chip-chev" />
            </button>
          }
        >
          <ProjectMenu onClose={() => setOpen(false)} onOpenFolder={onOpenFolder} />
        </Popover>
        <button
          className="icon-btn rail-new"
          disabled={!project}
          title="New session"
          onClick={() => void newSession()}
        >
          <SquarePen />
        </button>
      </header>

      <div className={filesOpen && project ? 'rail-section sessions is-split' : 'rail-section sessions'}>
        <div className="rail-label">Sessions</div>
        <SessionList />
      </div>

      {project && (
        <FileTree
          projectId={project.id}
          open={filesOpen}
          onToggle={() => setFilesOpen(!filesOpen)}
        />
      )}
    </aside>
  )
}

/** Switch between projects on this machine, or open another folder. */
export function ProjectMenu({
  onClose,
  onOpenFolder
}: {
  onClose: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const projects = useCoder((s) => s.projects)
  const projectId = useCoder((s) => s.projectId)
  const selectProject = useCoder((s) => s.selectProject)
  const removeProject = useCoder((s) => s.removeProject)
  return (
    <div className="menu menu-projects">
      <div className="menu-label">Projects on this machine</div>
      {projects.map((p) => (
        <div key={p.id} className={p.id === projectId ? 'menu-item is-active' : 'menu-item'}>
          <button
            className="menu-text"
            onClick={() => {
              onClose()
              void selectProject(p.id)
            }}
          >
            <b>{p.name}</b>
            <span>
              {shortPath(p.path)}
              {p.branch ? ` · ${p.branch}` : ''}
            </span>
          </button>
          {p.id === projectId && <Check className="menu-check" />}
          <button
            className="icon-btn menu-remove"
            title="Forget this project (the folder is not touched)"
            onClick={() => void removeProject(p.id)}
          >
            <X />
          </button>
        </div>
      ))}
      <div className="menu-sep" />
      <button
        className="menu-item menu-action"
        onClick={() => {
          onClose()
          onOpenFolder()
        }}
      >
        <FolderPlus /> Open folder…
      </button>
    </div>
  )
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function SessionList(): React.JSX.Element {
  const sessions = useCoder((s) => s.sessions)
  const sessionId = useCoder((s) => s.sessionId)
  const openSession = useCoder((s) => s.openSession)
  const deleteSession = useCoder((s) => s.deleteSession)
  const project = useCoder((s) => s.projects.find((p) => p.id === s.projectId))
  const branch = project?.branch ?? null
  // Where the session ran: "assetflow @ MacBook Air".
  const where = project ? (project.host ? `${project.name} @ ${project.host}` : project.name) : undefined

  return (
    <div className="session-list">
      {sessions.length === 0 && (
        <div className="rail-empty">No sessions yet. Ask the Coder something to start one.</div>
      )}
      {sessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          active={s.id === sessionId}
          branch={branch}
          where={where}
          onOpen={() => void openSession(s.id)}
          onDelete={() => {
            if (window.confirm('Delete this session? Changes it made to files stay as they are.'))
              void deleteSession(s.id)
          }}
        />
      ))}
    </div>
  )
}

const STATUS_TEXT: Record<Session['status'], string> = {
  idle: '',
  running: 'Working',
  awaiting_approval: 'Needs approval',
  error: 'Stopped with an error'
}

/** One session in a rail: where it ran and its age, the title, then the model and branch. */
export function SessionRow({
  session,
  active,
  branch = null,
  where,
  fallbackTitle = 'New session',
  onOpen,
  onDelete
}: {
  session: Session
  active: boolean
  branch?: string | null
  /** The project and machine, shown above the title. */
  where?: string
  fallbackTitle?: string
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const models = useModels((s) => s.models)
  const load = useModels((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  const model = describeModel(session.model, models)
  const status = STATUS_TEXT[session.status]

  return (
    <div className={`session-row${active ? ' is-active' : ''} is-${session.status}`}>
      <button className="session-main" onClick={onOpen}>
        <span className="session-line">
          {session.status === 'error' && <span className="session-dot is-error" title={status} />}
          {where ? (
            <span className="session-where" title={where}>
              {where}
            </span>
          ) : (
            <span className="session-title">{session.title || fallbackTitle}</span>
          )}
          {session.status === 'running' ? (
            <span className="spinner is-small" title={status} />
          ) : (
            <span className="session-time">{shortTime(session.updated_at)}</span>
          )}
        </span>
        {where && <span className="session-title">{session.title || fallbackTitle}</span>}
        <span className="session-meta">
          {session.status === 'awaiting_approval' ? (
            <span className="session-flag">{status}</span>
          ) : (
            <>
              <ModelLogo vendor={model.vendor} model={session.model} size={12} />
              <span className="session-model">{model.label}</span>
            </>
          )}
          {branch && (
            <span className="session-branch" title={`Branch ${branch}`}>
              <GitBranch />
              {branch}
            </span>
          )}
        </span>
      </button>
      <button className="icon-btn session-delete" title="Delete session" onClick={onDelete}>
        <Trash2 />
      </button>
    </div>
  )
}

// ---------- file tree ----------

const STATUS_LETTER: Record<string, string> = { created: 'A', modified: 'M', deleted: 'D' }

interface TreeCtx {
  projectId: string
  version: number
  expanded: Set<string>
  toggle: (path: string) => void
  changed: Map<string, string>
  active: string | null
  onOpen: (path: string) => void
}

function FileTree({
  projectId,
  open,
  onToggle
}: {
  projectId: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const changes = useCoder((s) => s.changes)
  const run = useCoder((s) => s.run)
  const panelTab = useCoder((s) => s.panelTab)
  const openFile = useCoder((s) => s.openFile)
  const project = useCoder((s) => s.projects.find((p) => p.id === projectId))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // Reload the tree when a run ends, since files may have appeared.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (run === 'idle') setVersion((v) => v + 1)
  }, [run, changes.length])
  useEffect(() => setExpanded(new Set()), [projectId])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const ctx: TreeCtx = {
    projectId,
    version,
    expanded,
    toggle,
    changed: new Map(changes.map((c) => [c.path, c.kind])),
    active: panelTab.startsWith('file:') ? panelTab.slice(5) : null,
    onOpen: openFile
  }

  return (
    <div className={open ? 'rail-section tree-section is-open' : 'rail-section tree-section'}>
      <div className="rail-label rail-label-row">
        <button className="rail-toggle" onClick={onToggle}>
          <ChevronRight className={open ? 'chev is-open' : 'chev'} />
          Files
        </button>
        {open && (
          <span className="rail-actions">
            <button className="icon-btn" title="Refresh" onClick={() => setVersion((v) => v + 1)}>
              <RotateCw />
            </button>
            <button className="icon-btn" title="Collapse folders" onClick={() => setExpanded(new Set())}>
              <ChevronsDownUp />
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="tree" role="tree" aria-label={project ? `Files in ${project.name}` : 'Files'}>
          <TreeLevel ctx={ctx} path="" depth={0} />
        </div>
      )}
      {open && project && (
        <div className="tree-foot" title={project.path}>
          <Laptop />
          <span>{shortPath(project.path)}</span>
        </div>
      )}
    </div>
  )
}

function TreeLevel({ ctx, path, depth }: { ctx: TreeCtx; path: string; depth: number }): React.JSX.Element {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null)
  const { projectId, version } = ctx
  useEffect(() => {
    let live = true
    void api.projects.tree(projectId, path, 1).then((res) => {
      if (live) setNodes(res.ok ? res.data : [])
    })
    return () => {
      live = false
    }
  }, [projectId, path, version])

  if (nodes === null) return <div className="tree-loading" />
  if (nodes.length === 0 && depth === 0) return <div className="rail-empty">This folder is empty.</div>
  return (
    <>
      {nodes.map((n) =>
        n.kind === 'dir' ? (
          <TreeDir key={n.path} node={n} ctx={ctx} depth={depth} />
        ) : (
          <button
            key={n.path}
            role="treeitem"
            className={`tree-row is-file${ctx.active === n.path ? ' is-active' : ''}${
              ctx.changed.has(n.path) ? ` is-${ctx.changed.get(n.path)}` : ''
            }`}
            onClick={() => ctx.onOpen(n.path)}
            title={n.path}
          >
            <Indent depth={depth} />
            <span className="tree-twist" />
            <FileIcon name={n.name} />
            <span className="tree-name">{n.name}</span>
            {ctx.changed.has(n.path) && (
              <span className="tree-status">{STATUS_LETTER[ctx.changed.get(n.path) ?? '']}</span>
            )}
          </button>
        )
      )}
    </>
  )
}

function TreeDir({ node, ctx, depth }: { node: TreeNode; ctx: TreeCtx; depth: number }): React.JSX.Element {
  const open = ctx.expanded.has(node.path)
  const touched = [...ctx.changed.keys()].some((p) => p.startsWith(`${node.path}/`))
  return (
    <>
      <button
        role="treeitem"
        aria-expanded={open}
        className={`tree-row is-dir${touched ? ' is-touched' : ''}`}
        onClick={() => ctx.toggle(node.path)}
        title={node.path}
      >
        <Indent depth={depth} />
        <ChevronRight className={open ? 'tree-twist chev is-open' : 'tree-twist chev'} />
        <FolderIcon name={node.name} open={open} />
        <span className="tree-name">{node.name}</span>
        {touched && <span className="tree-dot" />}
      </button>
      {open && <TreeLevel ctx={ctx} path={node.path} depth={depth + 1} />}
    </>
  )
}

/** Indent guides, one per level, like an editor's explorer. */
function Indent({ depth }: { depth: number }): React.JSX.Element | null {
  if (depth === 0) return null
  return (
    <span className="tree-indent" aria-hidden>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="tree-guide" />
      ))}
    </span>
  )
}
