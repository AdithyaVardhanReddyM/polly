import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Info,
  Lightbulb,
  SquareArrowOutUpRight,
  TriangleAlert
} from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSummary, ApprovalRequired, Source } from '../../../shared/contracts'
import { AgentAvatar } from '../components/AgentAvatar'
import { type RunState, type ToolItem, type TranscriptItem, useCoder } from '../store/coder'
import { ApprovalCard } from './ApprovalCard'
import { type Subagent, crewMember, crewOf, isBusy, roleOf, title } from './crew'
import { DiffView } from './DiffView'
import { CitationContext, Markdown } from './Markdown'
import { formatDuration, toolMeta } from './toolMeta'

/** Opens a project file beside the chat; only the Coder provides one. */
const OpenFileContext = createContext<((path: string) => void) | null>(null)

type AvatarAgent = Pick<AgentSummary, 'avatar' | 'division' | 'name'>

export function Transcript({ agent }: { agent?: AvatarAgent }): React.JSX.Element {
  const items = useCoder((s) => s.items)
  const approval = useCoder((s) => s.approval)
  const run = useCoder((s) => s.run)
  const openFile = useCoder((s) => s.openFile)
  return (
    <OpenFileContext.Provider value={openFile}>
      <TranscriptView items={items} run={run} approval={approval} agent={agent} />
    </OpenFileContext.Provider>
  )
}

// ---------- shaping the transcript into blocks ----------

type Assistant = Extract<TranscriptItem, { kind: 'assistant' }>

type Step =
  | { kind: 'thinking'; id: string; text: string; live: boolean }
  | { kind: 'tool'; id: string; tool: ToolItem }
  | { kind: 'subagent'; id: string; item: Subagent }

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; item: Assistant; last: boolean }
  | { kind: 'steps'; id: string; steps: Step[] }
  | { kind: 'notice'; id: string; item: Extract<TranscriptItem, { kind: 'notice' }> }

/**
 * Turn the flat item list into what a reader follows: the agent's prose, and
 * between it, runs of steps (its thinking, tool calls and delegations).
 */
function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = []
  let group: Extract<Block, { kind: 'steps' }> | null = null
  const step = (s: Step): void => {
    if (!group) {
      group = { kind: 'steps', id: `steps-${s.id}`, steps: [] }
      blocks.push(group)
    }
    group.steps.push(s)
  }
  for (const it of items) {
    switch (it.kind) {
      case 'user':
        group = null
        blocks.push({ kind: 'user', id: it.id, text: it.text })
        break
      case 'notice':
        group = null
        blocks.push({ kind: 'notice', id: it.id, item: it })
        break
      case 'assistant':
        if (it.reasoning.trim())
          step({ kind: 'thinking', id: `think-${it.id}`, text: it.reasoning, live: it.streaming && !it.text })
        if (it.text) {
          group = null
          blocks.push({ kind: 'text', id: it.id, item: it, last: false })
        }
        break
      case 'tool':
        step({ kind: 'tool', id: it.id, tool: it })
        break
      case 'subagent':
        step({ kind: 'subagent', id: it.id, item: it })
        break
    }
  }
  // The last prose before each user message (or the end) closes a turn.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind !== 'text') continue
    const rest = blocks.slice(i + 1)
    const nextUser = rest.findIndex((x) => x.kind === 'user')
    const before = nextUser < 0 ? rest : rest.slice(0, nextUser)
    b.last = !before.some((x) => x.kind === 'text')
  }
  return blocks
}

// ---------- the view ----------

/** A conversation with any agent. `sources` resolve `[n]` citations. */
export function TranscriptView({
  items,
  run,
  approval = null,
  sources = [],
  footer,
  agent
}: {
  items: TranscriptItem[]
  run: RunState
  approval?: ApprovalRequired | null
  sources?: Source[]
  /** Whose robot animates in the status line while a run is live. */
  agent?: AvatarAgent
  /** Shown after the last message (a scorecard, a report). */
  footer?: React.ReactNode
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  // Follow the stream while the user is at the bottom; stop when they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  }, [items, approval, footer, pinned])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const blocks = toBlocks(items)
  const running = run === 'running'
  const seconds = useRunClock(running)
  const lastBlock = blocks[blocks.length - 1]
  const crew = crewOf(items)
  const busy = running && isBusy(crew)

  return (
    <CitationContext.Provider value={sources}>
      <div className="transcript" ref={scroller}>
        <div className="transcript-inner">
          {blocks.map((b) => {
            switch (b.kind) {
              case 'user':
                return <UserMessage key={b.id} text={b.text} />
              case 'text':
                return (
                  <AssistantText
                    key={b.id}
                    text={b.item.text}
                    streaming={b.item.streaming}
                    actions={b.last && !b.item.streaming}
                  />
                )
              case 'steps':
                return <StepGroup key={b.id} steps={b.steps} live={running && b === lastBlock} />
              case 'notice':
                return <Notice key={b.id} tone={b.item.tone} text={b.item.text} />
            }
          })}
          {busy ? (
            <CrewBoard lead={agent} crew={crew} seconds={seconds} />
          ) : (
            running && <Working seconds={seconds} label={activity(items)} agent={agent} />
          )}
          {approval && <ApprovalCard approval={approval} />}
          {footer}
        </div>
        {!pinned && (
          <button
            className="jump-latest"
            onClick={() => {
              setPinned(true)
              const el = scroller.current
              if (el) el.scrollTop = el.scrollHeight
            }}
          >
            Jump to latest
          </button>
        )}
      </div>
    </CitationContext.Provider>
  )
}

function UserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="msg-user">
      <div className="bubble">{text}</div>
    </div>
  )
}

function AssistantText({
  text,
  streaming,
  actions
}: {
  text: string
  streaming: boolean
  actions: boolean
}): React.JSX.Element {
  const shown = useSmoothText(text, streaming)
  const typing = streaming || shown.length < text.length
  return (
    <div className={typing ? 'msg-assistant is-streaming' : 'msg-assistant'}>
      <Markdown text={shown} />
      {actions && (
        <div className="msg-actions">
          <CopyText text={text} />
        </div>
      )}
    </div>
  )
}

/**
 * Play streamed text out at a steady pace instead of in network-sized bursts.
 * The pace scales with the backlog, so the reveal never trails far behind,
 * and a finished reply catches up quickly. Text that was already complete
 * when it mounted (an opened session) shows at once.
 */
function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => (streaming ? 0 : text.length))
  const target = useRef(text.length)
  target.current = text.length
  const last = useRef(0)
  const live = useRef(streaming)
  live.current = streaming

  // A rewrite that shortens the text (rare) shows as is.
  const clamped = Math.min(shown, text.length)
  const behind = clamped < text.length

  useEffect(() => {
    if (!behind) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target.current)
      return
    }
    last.current = performance.now()
    const tick = window.setInterval(() => {
      const now = performance.now()
      const dt = Math.min(100, now - last.current) / 1000
      last.current = now
      setShown((cur) => {
        const backlog = target.current - cur
        if (backlog <= 0) return cur
        // ~60 chars/s at rest, faster when behind, and quick to finish.
        const rate = Math.max(60, backlog * (live.current ? 5 : 12))
        return Math.min(target.current, cur + Math.max(1, Math.round(rate * dt)))
      })
    }, 16)
    return () => window.clearInterval(tick)
  }, [behind])

  return text.slice(0, clamped)
}

function CopyText({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1400)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <button
      className="msg-action"
      title="Copy message"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}
    >
      {done ? <Check /> : <Copy />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Notice({
  tone,
  text
}: {
  tone: 'info' | 'warn' | 'error'
  text: string
}): React.JSX.Element {
  return (
    <div className={`notice is-${tone}`}>
      {tone === 'error' ? <CircleAlert /> : tone === 'warn' ? <TriangleAlert /> : <Info />}
      <span>{text}</span>
    </div>
  )
}

/** Seconds since the run started, ticking while it runs. */
function useRunClock(running: boolean): number {
  const started = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  if (running && started.current === null) started.current = Date.now()
  if (!running) started.current = null
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running])
  return started.current === null ? 0 : Math.max(0, Math.floor((now - started.current) / 1000))
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** What the agent is doing right now, in a few words. */
function activity(items: TranscriptItem[]): string {
  const last = items[items.length - 1]
  if (!last || last.kind === 'user') return 'Thinking'
  if (last.kind === 'assistant') return last.streaming ? (last.text ? 'Writing' : 'Thinking') : 'Working'
  if (last.kind === 'tool' && last.status === 'running') {
    const meta = toolMeta(last.name, last.args)
    return `${meta.verb} ${meta.target}`.trim()
  }
  if (last.kind === 'subagent' && last.status === 'running') {
    const step = last.tools[last.tools.length - 1]
    if (step?.status === 'running') {
      const meta = toolMeta(step.name, step.args)
      return `${capitalise(last.name)} · ${meta.verb} ${meta.target}`.trim()
    }
    return `${capitalise(last.name)} is working`
  }
  return 'Working'
}

/** The live status line: the agent's robot at work, what it is doing, for how long. */
function Working({
  seconds,
  label,
  agent
}: {
  seconds: number
  label: string
  agent?: AvatarAgent
}): React.JSX.Element {
  return (
    <div className="working" role="status" aria-live="polite">
      {agent ? (
        <span className="working-bot" aria-hidden>
          <AgentAvatar agent={agent} size={26} bare motion="fast" />
        </span>
      ) : (
        <span className="working-mark" aria-hidden />
      )}
      <span className="working-label shimmer" title={label}>
        {label}
      </span>
      {seconds >= 1 && <span className="working-time">{formatElapsed(seconds)}</span>}
    </div>
  )
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// ---------- the crew ----------

/** A once-a-second clock, for elapsed times that tick. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/** What a helper is doing right now, in a few words. */
function memberActivity(m: Subagent): string {
  if (m.status === 'error') return 'Failed'
  if (m.status === 'done') return `Done · ${m.tools.length} step${m.tools.length === 1 ? '' : 's'}`
  const step = m.tools[m.tools.length - 1]
  if (step?.status === 'running') {
    const meta = toolMeta(step.name, step.args)
    return `${meta.verb} ${meta.target}`.trim()
  }
  if (m.live) return 'Writing up'
  return m.tools.length ? 'Thinking' : 'Starting'
}

/** The names of the helpers still at work: "Explorer and Tester". */
export function crewLabel(crew: Subagent[]): string {
  const names = [...new Set(crew.filter((m) => m.status === 'running').map((m) => title(m.name)))]
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The lead and the helpers it has called on this turn, side by side: who is
 * on what, and how far along. Replaces the one-line status while any helper
 * is still working; once they all report back, the lead's status line returns.
 */
function CrewBoard({
  lead,
  crew,
  seconds
}: {
  lead?: AvatarAgent
  crew: Subagent[]
  seconds: number
}): React.JSX.Element {
  const now = useNow()
  const working = crew.filter((m) => m.status === 'running').length
  const leadName = lead?.name ?? 'Coder'
  return (
    <div className="crew-board" role="status" aria-live="polite">
      <div className="crew-lead">
        {lead ? (
          <span className="crew-lead-bot" aria-hidden>
            <AgentAvatar agent={lead} size={30} bare motion="fast" />
          </span>
        ) : (
          <span className="working-mark" aria-hidden />
        )}
        <div className="crew-lead-text">
          <b>{leadName}</b>
          <span className="shimmer">
            {working === 1 ? `Waiting on ${crewLabel(crew)}` : `Working with ${working} helpers`}
          </span>
        </div>
        {seconds >= 1 && <span className="working-time">{formatElapsed(seconds)}</span>}
      </div>
      <div className="crew-members">
        {crew.map((m) => (
          <CrewCard key={m.id} member={m} lead={lead} now={now} />
        ))}
      </div>
    </div>
  )
}

function CrewCard({
  member,
  lead,
  now
}: {
  member: Subagent
  lead?: AvatarAgent
  now: number
}): React.JSX.Element {
  const running = member.status === 'running'
  const started = member.startedAt
  const until = member.finishedAt ?? now
  const elapsed = started ? Math.max(0, Math.floor((until - started) / 1000)) : 0
  return (
    <div className={`crew-card is-${member.status}`}>
      <span className="crew-card-bot" aria-hidden>
        <AgentAvatar agent={crewMember(member.name, lead)} size={32} bare motion={running ? 'fast' : 'none'} />
      </span>
      <div className="crew-card-text">
        <div className="crew-card-head">
          <b>{title(member.name)}</b>
          <span className="crew-card-role">{roleOf(member.name)}</span>
          {started && elapsed >= 1 && <span className="crew-card-time">{formatElapsed(elapsed)}</span>}
        </div>
        <div className={running ? 'crew-status shimmer' : 'crew-status'} title={memberActivity(member)}>
          {memberActivity(member)}
        </div>
        <div className="crew-brief" title={member.description}>
          {member.description}
        </div>
      </div>
    </div>
  )
}

// ---------- steps ----------

/** "Read 3 files, ran 2 commands": what a folded run of steps did. */
function summarize(steps: Step[]): string {
  const counts = new Map<string, number>()
  const add = (k: string): void => {
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const s of steps) {
    if (s.kind === 'subagent') add('task')
    else if (s.kind === 'tool') add(s.tool.name)
  }
  const n = (name: string | string[]): number =>
    (Array.isArray(name) ? name : [name]).reduce((sum, k) => sum + (counts.get(k) ?? 0), 0)
  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`
  const phrases: string[] = []
  const read = n(['read_file', 'github_file'])
  const explored = n(['ls', 'glob'])
  const searched = n('grep')
  const edited = n(['edit_file', 'write_file', 'delete'])
  const ran = n('execute')
  const web = n(['web_search', 'research_search'])
  const pages = n('web_extract')
  const git = n(['git_status', 'git_diff', 'git_branch', 'git_commit'])
  const tasks = n('task')
  const pr = n(['github_pr_overview', 'github_pr_files', 'github_pr_checks'])
  if (read) phrases.push(`read ${plural(read, 'file', 'files')}`)
  if (explored) phrases.push(`listed ${plural(explored, 'folder', 'folders')}`)
  if (searched) phrases.push(`searched the code ${searched === 1 ? 'once' : `${searched} times`}`)
  if (edited) phrases.push(`edited ${plural(edited, 'file', 'files')}`)
  if (ran) phrases.push(`ran ${plural(ran, 'command', 'commands')}`)
  if (web) phrases.push(`searched the web ${web === 1 ? 'once' : `${web} times`}`)
  if (pages) phrases.push(`read ${plural(pages, 'page', 'pages')}`)
  if (pr) phrases.push(`inspected the PR ${pr === 1 ? 'once' : `${pr} times`}`)
  if (git) phrases.push(plural(git, 'git step', 'git steps'))
  if (tasks) phrases.push(`delegated ${plural(tasks, 'task', 'tasks')}`)
  const known =
    read + explored + searched + edited + ran + web + pages + git + tasks + pr + n('write_todos')
  const other = [...counts.values()].reduce((a, b) => a + b, 0) - known
  if (n('write_todos')) phrases.push('updated the plan')
  if (other > 0) phrases.push(plural(other, 'other step', 'other steps'))
  const text = phrases.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const FOLD_AFTER = 3

function StepGroup({ steps, live }: { steps: Step[]; live: boolean }): React.JSX.Element {
  const actions = steps.filter((s) => s.kind !== 'thinking')
  const problems = actions.filter(
    (s) =>
      (s.kind === 'tool' && ['error', 'blocked', 'waiting'].includes(s.tool.status)) ||
      (s.kind === 'subagent' && s.item.status === 'error')
  ).length
  const foldable = !live && actions.length > FOLD_AFTER
  const [open, setOpen] = useState(!foldable)
  // Fold a long run of steps once the agent moves on.
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live && actions.length > FOLD_AFTER) setOpen(false)
    wasLive.current = live
  }, [live, actions.length])

  if (foldable && !open) {
    return (
      <div className="steps">
        <button className="step-summary" onClick={() => setOpen(true)}>
          <span>{summarize(steps)}</span>
          {problems > 0 && <span className="step-problems">{problems} failed</span>}
          <ChevronRight className="chev" />
        </button>
      </div>
    )
  }
  return (
    <div className="steps">
      {foldable && (
        <button className="step-summary is-open" onClick={() => setOpen(false)}>
          <span>{summarize(steps)}</span>
          <ChevronRight className="chev is-open" />
        </button>
      )}
      {steps.map((s) =>
        s.kind === 'thinking' ? (
          <Thinking key={s.id} text={s.text} live={s.live} />
        ) : s.kind === 'tool' ? (
          <ToolCard key={s.id} tool={s.tool} />
        ) : (
          <SubagentStep key={s.id} item={s.item} />
        )
      )}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const preview = text.trim().split('\n').filter(Boolean).slice(-2).join(' ')
  return (
    <div className={`step is-thinking${open ? ' is-open' : ''}`}>
      <button className="step-head" onClick={() => setOpen(!open)}>
        <span className="step-icon">
          <Lightbulb />
        </span>
        <span className={live ? 'step-verb shimmer' : 'step-verb'}>{live ? 'Thinking' : 'Thought'}</span>
        {!open && <span className="step-target is-prose">{preview}</span>}
        <ChevronRight className={open ? 'chev is-open' : 'chev'} />
      </button>
      {open && <div className="step-body thinking-text">{text.trim()}</div>}
    </div>
  )
}

const STATUS_LABEL: Record<ToolItem['status'], string> = {
  running: '',
  ok: '',
  error: 'Failed',
  blocked: 'Blocked',
  waiting: 'Needs approval',
  rejected: 'Rejected'
}

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

/** One tool call: a single line that opens to its output. */
export function ToolCard({
  tool,
  compact = false
}: {
  tool: ToolItem
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openFile = useContext(OpenFileContext)
  const meta = toolMeta(tool.name, tool.args)
  const hasBody = tool.output !== undefined || tool.name === 'edit_file' || tool.name === 'write_file'
  const projectFile =
    FILE_TOOLS.has(tool.name) &&
    !/^(memories|conversation_history)\//.test(meta.target) &&
    tool.status !== 'rejected'
  const label = STATUS_LABEL[tool.status]

  return (
    <div className={`step is-tool is-${tool.status}${compact ? ' is-compact' : ''}${open ? ' is-open' : ''}`}>
      <div className="step-line">
        <button className="step-head" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
          <span className="step-icon">{tool.status === 'running' ? <span className="spinner" /> : meta.icon}</span>
          <span className={tool.status === 'running' ? 'step-verb shimmer' : 'step-verb'}>{meta.verb}</span>
          <span className="step-target" title={meta.target}>
            {meta.target}
          </span>
          {label && <span className="step-status">{label}</span>}
          {tool.status === 'ok' && tool.durationMs ? (
            <span className="step-time">{formatDuration(tool.durationMs)}</span>
          ) : null}
          {hasBody && <ChevronRight className={open ? 'chev is-open' : 'chev'} />}
        </button>
        {openFile && projectFile && (
          <button className="step-open" title="Open file" onClick={() => openFile(meta.target)}>
            <SquareArrowOutUpRight />
          </button>
        )}
      </div>
      {open && <ToolBody tool={tool} path={projectFile ? meta.target : undefined} />}
    </div>
  )
}

function ToolBody({ tool, path }: { tool: ToolItem; path?: string }): React.JSX.Element {
  const a = tool.args
  if (tool.name === 'edit_file' || tool.name === 'write_file') {
    return (
      <div className="step-body">
        <div className="step-diff">
          {tool.name === 'edit_file' ? (
            <DiffView
              before={String(a.old_string ?? '')}
              after={String(a.new_string ?? '')}
              context={2}
              path={path}
            />
          ) : (
            <DiffView before="" after={String(a.content ?? '')} context={0} maxLines={200} path={path} />
          )}
        </div>
        {tool.status !== 'ok' && tool.output && <pre className="step-output">{tool.output}</pre>}
      </div>
    )
  }
  return (
    <div className="step-body">
      <pre className="step-output">
        {tool.name === 'execute' && <span className="step-prompt">
            $ {String(a.command ?? '')}
            {'\n'}
          </span>}
        {tool.output || '(no output)'}
        {tool.truncated && <span className="step-more">{'\n'}… output truncated</span>}
      </pre>
    </div>
  )
}

function SubagentStep({ item }: { item: Subagent }): React.JSX.Element {
  const [open, setOpen] = useState(item.status === 'running')
  useEffect(() => {
    setOpen(item.status === 'running')
  }, [item.status])
  const steps = item.tools.length
  return (
    <div className={`step is-subagent is-${item.status}${open ? ' is-open' : ''}`}>
      <button className="step-head" onClick={() => setOpen(!open)}>
        <span className="step-icon is-bot">
          <AgentAvatar agent={crewMember(item.name)} size={18} bare motion={item.status === 'running' ? 'fast' : 'none'} />
        </span>
        <span className={item.status === 'running' ? 'step-verb shimmer' : 'step-verb'}>{title(item.name)}</span>
        <span className="step-target is-prose" title={item.description}>
          {item.description}
        </span>
        {item.status === 'error' ? (
          <span className="step-status">Failed</span>
        ) : steps > 0 ? (
          <span className="step-time">
            {steps} step{steps === 1 ? '' : 's'}
          </span>
        ) : null}
        <ChevronRight className={open ? 'chev is-open' : 'chev'} />
      </button>
      {open && (
        <div className="step-body subagent-body">
          {item.tools.map((t) => (
            <ToolCard key={t.id} tool={t} compact />
          ))}
          {item.status === 'running' && item.live && <div className="subagent-live">{item.live}</div>}
          {item.summary && (
            <div className="subagent-summary">
              <Markdown text={item.summary} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
