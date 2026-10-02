import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FilePen,
  FileText,
  ListChecks,
  RotateCcw,
  Ban,
  Telescope,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FileChange, FileDiff, Rule } from '../../../shared/contracts'
import { api } from '../api'
import { ReportCard } from '../research/Cards'
import { useChangeResearch } from '../store/agentSession'
import { type PanelTab, type ToolItem, useCoder } from '../store/coder'
import { DiffView } from './DiffView'
import { FileViewer } from './FileViewer'
import { FileIcon } from './icons'
import { MODES } from './Composer'
import { ToolCard } from './Transcript'
import { formatTokens } from './toolMeta'

type Tab = Exclude<PanelTab, `file:${string}`>

export function Inspector(): React.JSX.Element {
  const changes = useCoder((s) => s.changes)
  const todos = useCoder((s) => s.todos)
  const sessionId = useCoder((s) => s.sessionId)
  const researchId = useCoder((s) => s.researchId)
  const tab = useCoder((s) => s.panelTab)
  const setTab = useCoder((s) => s.setPanelTab)
  const openFiles = useCoder((s) => s.openFiles)
  const closeFile = useCoder((s) => s.closeFile)
  const researching = useChangeResearch((s) => s.run === 'running')
  const findings = useChangeResearch(
    (s) => s.report?.findings.filter((f) => f.severity !== 'info').length ?? 0
  )
  const open = todos.filter((t) => t.status !== 'completed').length
  const tabs = useRef<HTMLDivElement>(null)

  // Jump to the plan the first time one appears in a session.
  const hasTodos = todos.length > 0
  useEffect(() => {
    if (hasTodos && changes.length === 0 && !useCoder.getState().panelTab.startsWith('file:'))
      setTab('plan')
  }, [hasTodos]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow this session's change research; show it when a new one starts.
  const seen = useRef<{ session: string | null; research: string | null }>({
    session: null,
    research: null
  })
  useEffect(() => {
    const changeResearch = useChangeResearch.getState()
    if (researchId) void changeResearch.open(researchId)
    else changeResearch.newSession()
    const prev = seen.current
    if (researchId && prev.session === sessionId && prev.research !== researchId) setTab('research')
    seen.current = { session: sessionId, research: researchId }
  }, [researchId, sessionId, setTab])

  // Keep the active file tab in view.
  useEffect(() => {
    tabs.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

  const file = tab.startsWith('file:') ? tab.slice(5) : null

  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist">
        <TabButton id="changes" tab={tab} onSelect={setTab} count={changes.length}>
          Changes
        </TabButton>
        <TabButton id="plan" tab={tab} onSelect={setTab} count={open}>
          Plan
        </TabButton>
        <TabButton id="research" tab={tab} onSelect={setTab} count={findings} live={researching}>
          Research
        </TabButton>
        <TabButton id="session" tab={tab} onSelect={setTab}>
          Session
        </TabButton>
      </div>
      {openFiles.length > 0 && (
        <div className="file-tabs" role="tablist" aria-label="Open files" ref={tabs}>
          {openFiles.map((path) => {
            const name = path.split('/').pop() ?? path
            const active = tab === `file:${path}`
            return (
              <div
                key={path}
                role="tab"
                aria-selected={active}
                className={active ? 'ftab is-active' : 'ftab'}
                title={path}
                onClick={() => setTab(`file:${path}`)}
                onAuxClick={(e) => {
                  if (e.button === 1) closeFile(path)
                }}
              >
                <FileIcon name={name} />
                <span>{name}</span>
                <button
                  className="ftab-close"
                  title="Close"
                  aria-label={`Close ${name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeFile(path)
                  }}
                >
                  <X />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className={file ? 'inspector-body is-file' : 'inspector-body'}>
        {file ? (
          <FileViewer key={file} path={file} />
        ) : (
          <>
            {tab === 'changes' && <ChangesPanel />}
            {tab === 'plan' && <PlanPanel />}
            {tab === 'research' && <ResearchPanel />}
            {tab === 'session' && <SessionPanel />}
          </>
        )}
      </div>
    </aside>
  )
}

function TabButton({
  id,
  tab,
  onSelect,
  count,
  live = false,
  children
}: {
  id: Tab
  tab: PanelTab
  onSelect: (t: Tab) => void
  count?: number
  live?: boolean
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
      {live ? <span className="spinner is-small" /> : null}
      {!live && count ? <span className="itab-count">{count}</span> : null}
    </button>
  )
}

// ---------- changes ----------

const KIND_LETTER = { created: 'A', modified: 'M', deleted: 'D' }

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
  const openFile = useCoder((s) => s.openFile)
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
          <FileIcon name={name} />
          <span className="change-path" title={change.path}>
            <b>{name}</b>
            {dir && <span>{dir}</span>}
          </span>
          <span className="change-stat">
            {change.additions > 0 && <span className="adds">+{change.additions}</span>}
            {change.deletions > 0 && <span className="dels">−{change.deletions}</span>}
          </span>
          <span className={`change-kind is-${change.kind}`} title={change.kind}>
            {KIND_LETTER[change.kind]}
          </span>
        </button>
        <span className="change-btns">
          {change.kind !== 'deleted' && (
            <button className="icon-btn" title="Open file" onClick={() => openFile(change.path)}>
              <FileText />
            </button>
          )}
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
            <DiffView before={diff.before} after={diff.after} path={change.path} />
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

// ---------- research ----------

function ResearchPanel(): React.JSX.Element {
  const sessionId = useCoder((s) => s.sessionId)
  const changes = useCoder((s) => s.changes)
  const busy = useCoder((s) => s.run !== 'idle')
  const project = useCoder((s) => s.projects.find((p) => p.id === s.projectId))
  const researchNow = useCoder((s) => s.researchNow)
  const setAutoResearch = useCoder((s) => s.setAutoResearch)
  const report = useChangeResearch((s) => s.report)
  const run = useChangeResearch((s) => s.run)
  const items = useChangeResearch((s) => s.items)
  const error = useChangeResearch((s) => s.error)
  const researchId = useCoder((s) => s.researchId)
  const [searchReady, setSearchReady] = useState<boolean | null>(null)

  useEffect(() => {
    void api.integrations.status().then((r) => setSearchReady(r.ok ? r.data.tavily.configured : null))
  }, [])

  const auto = project?.settings.auto_research ?? true
  const running = run === 'running'
  const steps = items
    .flatMap((it): ToolItem[] =>
      it.kind === 'tool' ? [it] : it.kind === 'subagent' ? it.tools : []
    )
    .filter((t) => t.name !== 'write_todos')

  return (
    <div className="research-panel">
      <div className="research-controls">
        <label className="switch-row">
          <input
            type="checkbox"
            className="switch"
            checked={auto}
            disabled={!project}
            onChange={(e) => void setAutoResearch(e.target.checked)}
          />
          <span>
            <b>Research every change</b>
            <span>When a run edits files, check them against current docs, deprecations and advisories.</span>
          </span>
        </label>
        <button
          className="btn btn-sm"
          disabled={!sessionId || busy || running || changes.length === 0 || searchReady === false}
          title={changes.length === 0 ? 'No changes to research yet' : undefined}
          onClick={() => void researchNow()}
        >
          <Telescope /> Research this change
        </button>
        {searchReady === false && (
          <p className="muted">
            Needs web search: add <code>TAVILY_API_KEY</code> to <code>.env</code>.
          </p>
        )}
      </div>

      {error && <p className="post-error">{error}</p>}

      {!researchId ? (
        <div className="inspector-empty">
          <Telescope />
          <b>Not researched yet</b>
          <span>
            After the Coder finishes, Polly verifies the change against the web and drafts a PR
            description.
          </span>
        </div>
      ) : report ? (
        <ReportCard report={report} />
      ) : (
        <div className="research-live">
          <div className="research-status">
            {running ? <span className="spinner" /> : <Telescope />}
            {running ? 'Checking docs, deprecations and advisories…' : 'Research ended without a report.'}
          </div>
          <div className="research-steps">
            {steps.slice(-10).map((t) => (
              <ToolCard key={t.id} tool={t} compact />
            ))}
          </div>
        </div>
      )}
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
