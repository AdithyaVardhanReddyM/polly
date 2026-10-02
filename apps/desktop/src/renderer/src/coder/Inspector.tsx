import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FileMinus,
  FilePen,
  FilePlus,
  ListChecks,
  RotateCcw,
  Ban,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileChange, FileDiff, Rule } from '../../../shared/contracts'
import { api } from '../api'
import { useCoder } from '../store/coder'
import { DiffView } from './DiffView'
import { MODES } from './Composer'
import { formatTokens } from './toolMeta'

type Tab = 'changes' | 'plan' | 'session'

export function Inspector(): React.JSX.Element {
  const changes = useCoder((s) => s.changes)
  const todos = useCoder((s) => s.todos)
  const [tab, setTab] = useState<Tab>('changes')
  const open = todos.filter((t) => t.status !== 'completed').length

  // Jump to the plan the first time one appears in a session.
  const hasTodos = todos.length > 0
  useEffect(() => {
    if (hasTodos && changes.length === 0) setTab('plan')
  }, [hasTodos]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist">
        <TabButton id="changes" tab={tab} onSelect={setTab} count={changes.length}>
          Changes
        </TabButton>
        <TabButton id="plan" tab={tab} onSelect={setTab} count={open}>
          Plan
        </TabButton>
        <TabButton id="session" tab={tab} onSelect={setTab}>
          Session
        </TabButton>
      </div>
      <div className="inspector-body">
        {tab === 'changes' && <ChangesPanel />}
        {tab === 'plan' && <PlanPanel />}
        {tab === 'session' && <SessionPanel />}
      </div>
    </aside>
  )
}

function TabButton({
  id,
  tab,
  onSelect,
  count,
  children
}: {
  id: Tab
  tab: Tab
  onSelect: (t: Tab) => void
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={tab === id}
      className={tab === id ? 'itab is-active' : 'itab'}
      onClick={() => onSelect(id)}
    >
      {children}
      {count ? <span className="itab-count">{count}</span> : null}
    </button>
  )
}

// ---------- changes ----------

const KIND_ICON = {
  created: <FilePlus />,
  modified: <FilePen />,
  deleted: <FileMinus />
}

function ChangesPanel(): React.JSX.Element {
  const changes = useCoder((s) => s.changes)
  const run = useCoder((s) => s.run)
  const sessionId = useCoder((s) => s.sessionId)
  const accept = useCoder((s) => s.acceptChanges)
  const revert = useCoder((s) => s.revertChanges)
  const [open, setOpen] = useState<string | null>(null)

  if (!sessionId || changes.length === 0) {
    return (
      <div className="inspector-empty">
        <FilePen />
        <b>No changes yet</b>
        <span>Files the Coder creates, edits or deletes in this session show up here, ready to keep or undo.</span>
      </div>
    )
  }

  const adds = changes.reduce((n, c) => n + c.additions, 0)
  const dels = changes.reduce((n, c) => n + c.deletions, 0)
  const busy = run === 'running'

  return (
    <div className="changes">
      <div className="changes-head">
        <span>
          {changes.length} file{changes.length === 1 ? '' : 's'}
          <span className="adds">+{adds}</span>
          <span className="dels">−{dels}</span>
        </span>
        <span className="changes-actions">
          <button
            className="btn btn-sm"
            disabled={busy}
            title="Restore every file to how it was before this session"
            onClick={() => {
              if (window.confirm(`Undo all ${changes.length} changes from this session?`)) void revert()
            }}
          >
            <RotateCcw /> Undo all
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => void accept()}>
            <Check /> Keep all
          </button>
        </span>
      </div>
      <div className="change-list">
        {changes.map((c) => (
          <ChangeRow
            key={c.path}
            change={c}
            open={open === c.path}
            busy={busy}
            onToggle={() => setOpen(open === c.path ? null : c.path)}
            onAccept={() => void accept([c.path])}
            onRevert={() => void revert([c.path])}
          />
        ))}
      </div>
    </div>
  )
}

function ChangeRow({
  change,
  open,
  busy,
  onToggle,
  onAccept,
  onRevert
}: {
  change: FileChange
  open: boolean
  busy: boolean
  onToggle: () => void
  onAccept: () => void
  onRevert: () => void
}): React.JSX.Element {
  const sessionId = useCoder((s) => s.sessionId)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const name = change.path.split('/').pop() ?? change.path
  const dir = change.path.slice(0, change.path.length - name.length)

  useEffect(() => {
    if (!open || !sessionId) return
    let live = true
    void api.sessions.diff(sessionId, change.path).then((res) => {
      if (live && res.ok) setDiff(res.data)
    })
    return () => {
      live = false
    }
  }, [open, sessionId, change.path, change.additions, change.deletions])

  return (
    <div className={open ? 'change is-open' : 'change'}>
      <div className="change-row">
        <button className="change-main" onClick={onToggle}>
          <ChevronRight className={open ? 'chev is-open' : 'chev'} />
          <span className={`change-kind is-${change.kind}`}>{KIND_ICON[change.kind]}</span>
          <span className="change-path" title={change.path}>
            <b>{name}</b>
            {dir && <span>{dir}</span>}
          </span>
          <span className="change-stat">
            {change.additions > 0 && <span className="adds">+{change.additions}</span>}
            {change.deletions > 0 && <span className="dels">−{change.deletions}</span>}
          </span>
        </button>
        <span className="change-btns">
          <button className="icon-btn" title="Undo this change" disabled={busy} onClick={onRevert}>
            <RotateCcw />
          </button>
          <button className="icon-btn" title="Keep this change" onClick={onAccept}>
            <Check />
          </button>
        </span>
      </div>
      {open && (
        <div className="change-diff">
          {!diff ? (
            <div className="diff-empty">Loading…</div>
          ) : diff.binary ? (
            <div className="diff-empty">Binary or very large file.</div>
          ) : (
            <DiffView before={diff.before} after={diff.after} />
          )}
          {change.source === 'shell' && (
            <div className="change-note">Changed by a command; compared with the last commit.</div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- plan ----------

function PlanPanel(): React.JSX.Element {
  const todos = useCoder((s) => s.todos)
  if (todos.length === 0) {
    return (
      <div className="inspector-empty">
        <ListChecks />
        <b>No plan yet</b>
        <span>For multi-step work the Coder writes a checklist here and ticks it off as it goes.</span>
      </div>
    )
  }
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="plan">
      <div className="plan-progress">
        <span>
          {done} of {todos.length} done
        </span>
        <div className="bar">
          <div style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
      </div>
      <ol className="todos">
        {todos.map((t, i) => (
          <li key={i} className={`todo is-${t.status}`}>
            {t.status === 'completed' ? (
              <CircleCheck />
            ) : t.status === 'in_progress' ? (
              <CircleDot />
            ) : (
              <Circle />
            )}
            <span>{t.content}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---------- session ----------

function SessionPanel(): React.JSX.Element {
  const session = useCoder((s) => s.session)
  const usage = useCoder((s) => s.usage)
  const models = useCoder((s) => s.models)
  const project = useCoder((s) => s.projects.find((p) => p.id === s.projectId))
  const generateGuide = useCoder((s) => s.generateGuide)
  const [rules, setRules] = useState<Rule[]>([])
  const [guide, setGuide] = useState<{ polly: boolean; memory: string | null } | null>(null)

  const projectId = project?.id
  const busy = useCoder((s) => s.run !== 'idle')
  useEffect(() => {
    if (!projectId) return
    void api.projects.rules(projectId).then((r) => r.ok && setRules(r.data))
    void api.projects.memory(projectId).then(
      (r) => r.ok && setGuide({ polly: r.data.polly_md !== null, memory: r.data.memory_md })
    )
  }, [projectId, busy])

  if (!project) return <div className="inspector-empty">Open a project first.</div>

  const model = models.find((m) => m.id === (session?.model || project.settings.default_model))
  const mode = MODES.find((m) => m.id === (session?.mode || project.settings.default_mode))
  const pct =
    usage.contextWindow && usage.contextTokens
      ? Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
      : 0

  return (
    <div className="session-panel">
      <section>
        <h4>Usage</h4>
        <dl className="kv">
          <dt>Model</dt>
          <dd>{model?.label ?? session?.model}</dd>
          <dt>Permissions</dt>
          <dd>{mode?.label}</dd>
          <dt>Context</dt>
          <dd>
            {usage.contextTokens ? formatTokens(usage.contextTokens) : '—'}
            {usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ''}
            {pct ? ` · ${pct.toFixed(0)}%` : ''}
          </dd>
          <dt>Tokens in</dt>
          <dd>{formatTokens(usage.session.input_tokens)}</dd>
          <dt>Tokens out</dt>
          <dd>{formatTokens(usage.session.output_tokens)}</dd>
        </dl>
      </section>

      <section>
        <h4>Project guide</h4>
        <p className="muted">
          <code>POLLY.md</code> in the project root tells the Coder how to build, test and navigate
          this codebase. It is read at the start of every session.
        </p>
        <button className="btn btn-sm" disabled={busy} onClick={() => void generateGuide()}>
          {guide?.polly ? 'Regenerate POLLY.md' : 'Generate POLLY.md'}
        </button>
      </section>

      <section>
        <h4>Memory</h4>
        {guide?.memory?.trim() ? (
          <pre className="memory">{guide.memory}</pre>
        ) : (
          <p className="muted">Nothing remembered yet. The Coder notes durable facts about this project as it works.</p>
        )}
      </section>

      <section>
        <h4>Always allowed</h4>
        {rules.length === 0 ? (
          <p className="muted">Rules you add from an approval card appear here.</p>
        ) : (
          <ul className="rules">
            {rules.map((r, i) => (
              <li key={`${r.tool}-${r.pattern}-${i}`}>
                <code>{r.tool}</code>
                <span>{r.pattern || 'any'}</span>
                <button
                  className="icon-btn"
                  title="Remove rule"
                  onClick={() =>
                    void api.projects.removeRule(project.id, i).then((res) => res.ok && setRules(res.data))
                  }
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4>Blocked commands</h4>
        <ul className="rules">
          {project.settings.command_denylist.map((c) => (
            <li key={c}>
              <Ban className="muted-icon" />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
