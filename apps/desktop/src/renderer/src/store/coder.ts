import { create } from 'zustand'
import type {
  ApprovalRequired,
  CoderEvent,
  Decision,
  Effort,
  FileChange,
  ModelOption,
  PermissionMode,
  Project,
  RememberRule,
  Session,
  Todo,
  ToolCallRef,
  UsageTotals,
  WireMessage
} from '../../../shared/contracts'
import { api, streams } from '../api'
import { stream } from '../sse'

// ---------- transcript items ----------

export type ToolStatus = 'running' | 'ok' | 'error' | 'blocked' | 'waiting' | 'rejected'

export interface ToolItem {
  kind: 'tool'
  id: string // the tool call id
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  output?: string
  truncated?: boolean
  durationMs?: number | null
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant'
      id: string
      text: string
      reasoning: string
      streaming: boolean
    }
  | ToolItem
  | {
      kind: 'subagent'
      id: string // the `task` tool call id
      name: string
      description: string
      status: 'running' | 'done' | 'error'
      summary?: string
      live?: string // latest streamed text, while running
      /** A teammate (another agent, called with `ask_teammate`), not a helper. */
      teammate?: boolean
      /** The teammate's agent id, once its run says so. */
      agentId?: string
      /** The teammate message `live` is streaming. */
      liveId?: string
      tools: ToolItem[]
      /** Wall-clock bounds of a live run; unknown for a reloaded session. */
      startedAt?: number
      finishedAt?: number
    }
  | { kind: 'notice'; id: string; tone: 'info' | 'warn' | 'error'; text: string }

export type RunState = 'idle' | 'running' | 'awaiting_approval'

/** What the right-hand panel shows: a fixed view or an open file. */
export type PanelTab = 'changes' | 'plan' | 'research' | 'session' | `file:${string}`

export interface UsageSnapshot {
  session: UsageTotals
  contextTokens: number
  contextWindow: number | null
}

const EMPTY_USAGE: UsageTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

interface CoderState {
  models: ModelOption[]
  projects: Project[]
  projectId: string | null
  sessions: Session[]
  sessionId: string | null
  session: Session | null

  items: TranscriptItem[]
  todos: Todo[]
  changes: FileChange[]
  approval: ApprovalRequired | null
  run: RunState
  usage: UsageSnapshot
  error: string | null
  lastSeq: number
  /** The latest change research for this session (a child session). */
  researchId: string | null

  /** The right-hand panel: whether it shows, which tab, and the files open in it. */
  panelOpen: boolean
  panelTab: PanelTab
  openFiles: string[]

  // actions
  boot: () => Promise<void>
  openFolder: (path: string) => Promise<boolean>
  selectProject: (id: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  newSession: () => Promise<void>
  openSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  send: (text: string) => Promise<void>
  decide: (decisions: Decision[], remember?: RememberRule[]) => Promise<void>
  cancel: () => Promise<void>
  setMode: (mode: PermissionMode) => Promise<void>
  setModel: (model: string) => Promise<void>
  /** How hard the model thinks: the open session's, or the next one's. */
  setEffort: (effort: Effort) => Promise<void>
  refreshChanges: () => Promise<void>
  acceptChanges: (paths?: string[]) => Promise<void>
  revertChanges: (paths?: string[]) => Promise<void>
  generateGuide: () => Promise<void>
  researchNow: () => Promise<void>
  setAutoResearch: (on: boolean) => Promise<void>
  clearError: () => void
  setPanelOpen: (open: boolean) => void
  setPanelTab: (tab: PanelTab) => void
  /** Open a project file (relative path) in the panel, beside the chat. */
  openFile: (path: string) => void
  closeFile: (path: string) => void
}

let controller: AbortController | null = null
const LAST_PROJECT = 'polly.coder.project'

function remember(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage can be unavailable; nothing depends on it */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function sessionHash(id: string | null): void {
  const next = id ? `#coder/${id}` : '#coder'
  if (window.location.hash !== next) window.history.replaceState(null, '', next)
}

// ---------- building the transcript ----------

/** Rebuild transcript items from stored messages (opening a session). */
export function fromWire(messages: WireMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const tools = new Map<string, ToolItem>()
  const tasks = new Map<string, Extract<TranscriptItem, { kind: 'subagent' }>>()
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ kind: 'user', id: m.id, text: m.text })
    } else if (m.role === 'assistant') {
      if (m.text || m.reasoning) {
        items.push({
          kind: 'assistant',
          id: m.id,
          text: m.text,
          reasoning: m.reasoning,
          streaming: false
        })
      }
      for (const call of m.tool_calls) {
        if (call.name === 'task' || call.name === ASK_TEAMMATE) {
          const task = subagentFor(call)
          tasks.set(call.id, task)
          items.push(task)
        } else {
          const tool: ToolItem = {
            kind: 'tool',
            id: call.id,
            name: call.name,
            args: call.args,
            status: 'waiting'
          }
          tools.set(call.id, tool)
          items.push(tool)
        }
      }
    } else {
      const task = tasks.get(m.call_id)
      if (task) {
        task.status = m.status === 'ok' ? 'done' : 'error'
        task.summary = m.output
        continue
      }
      const tool = tools.get(m.call_id)
      if (tool) {
        tool.status = m.status
        tool.output = m.output
        tool.truncated = m.truncated
      }
    }
  }
  return items
}

/** The tool one agent hands work to another with (`agents/delegation.py`). */
export const ASK_TEAMMATE = 'ask_teammate'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

function subagentFor(call: ToolCallRef): SubagentItem {
  if (call.name === ASK_TEAMMATE) {
    return {
      kind: 'subagent',
      id: call.id,
      // The name or id the lead wrote; the teammate's own events carry its id.
      name: String(call.args.teammate ?? 'teammate'),
      description: String(call.args.message ?? ''),
      status: 'running',
      teammate: true,
      tools: []
    }
  }
  return {
    kind: 'subagent',
    id: call.id,
    name: String(call.args.subagent_type ?? 'subagent'),
    description: String(call.args.description ?? ''),
    status: 'running',
    tools: []
  }
}

/**
 * A teammate's own events, passed up inside the lead's run (`event.via` is
 * the lead's call). They fill in the teammate's entry: its steps, and its
 * reply as it is written.
 */
function reduceTeammate(items: TranscriptItem[], event: CoderEvent): TranscriptItem[] {
  const i = items.findIndex((it) => it.kind === 'subagent' && it.id === event.via)
  if (i < 0) return items
  const mate = items[i] as SubagentItem
  const put = (next: SubagentItem): TranscriptItem[] => {
    const copy = items.slice()
    copy[i] = { ...next, agentId: event.teammate ?? next.agentId }
    return copy
  }
  switch (event.type) {
    case 'message.delta': {
      // Only what the teammate itself says is its reply; its helpers stay quiet.
      if (event.agent !== event.teammate || !event.text) return items
      const fresh = mate.liveId !== event.message_id
      return put({
        ...mate,
        live: (fresh ? '' : (mate.live ?? '')) + event.text,
        liveId: event.message_id
      })
    }
    case 'message.completed':
      if (event.agent !== event.teammate || !event.text) return items
      return put({ ...mate, live: event.text, liveId: event.message_id })
    case 'tool.call':
      if (mate.tools.some((t) => t.id === event.call_id)) return items
      return put({
        ...mate,
        tools: [
          ...mate.tools,
          { kind: 'tool', id: event.call_id, name: event.name, args: event.args, status: 'running' }
        ]
      })
    case 'tool.result': {
      const k = mate.tools.findIndex((t) => t.id === event.call_id)
      if (k < 0) return items
      const tools = mate.tools.slice()
      tools[k] = {
        ...tools[k],
        status: event.status,
        output: event.output,
        truncated: event.truncated,
        durationMs: event.duration_ms
      }
      return put({ ...mate, tools })
    }
    default:
      return items
  }
}

/** Apply one stream event to the transcript. Pure: returns new arrays.
 * `main` is the agent whose messages are the conversation; others are subagents. */
export function reduce(items: TranscriptItem[], event: CoderEvent, main = 'coder'): TranscriptItem[] {
  if (event.via) return reduceTeammate(items, event)
  const isMain = (agent: string): boolean => agent === main
  const runningTask = (agent: string): number => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind !== 'subagent' || it.teammate || it.status !== 'running') continue
      if (it.name === agent || agent === 'subagent') return i
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'subagent' && !it.teammate && it.status === 'running') return i
    }
    return -1
  }
  const replace = (index: number, item: TranscriptItem): TranscriptItem[] => {
    const next = items.slice()
    next[index] = item
    return next
  }

  switch (event.type) {
    case 'message.delta': {
      if (!isMain(event.agent)) {
        const i = runningTask(event.agent)
        if (i < 0) return items
        const task = items[i] as Extract<TranscriptItem, { kind: 'subagent' }>
        if (!event.text) return items
        return replace(i, { ...task, live: ((task.live ?? '') + event.text).slice(-400) })
      }
      const i = items.findIndex((it) => it.kind === 'assistant' && it.id === event.message_id)
      if (i < 0) {
        return [
          ...items,
          {
            kind: 'assistant',
            id: event.message_id,
            text: event.text ?? '',
            reasoning: event.reasoning ?? '',
            streaming: true
          }
        ]
      }
      const cur = items[i] as Extract<TranscriptItem, { kind: 'assistant' }>
      return replace(i, {
        ...cur,
        text: cur.text + (event.text ?? ''),
        reasoning: cur.reasoning + (event.reasoning ?? ''),
        streaming: true
      })
    }

    case 'message.completed': {
      if (!isMain(event.agent)) return items
      const i = items.findIndex((it) => it.kind === 'assistant' && it.id === event.message_id)
      const done: TranscriptItem = {
        kind: 'assistant',
        id: event.message_id,
        text: event.text,
        reasoning: event.reasoning,
        streaming: false
      }
      if (i >= 0) return replace(i, done)
      if (!event.text && !event.reasoning) return items
      return [...items, done]
    }

    case 'tool.call': {
      if (items.some((it) => (it.kind === 'tool' || it.kind === 'subagent') && it.id === event.call_id))
        return items // a resumed run replays the call that paused it
      if ((event.name === 'task' || event.name === ASK_TEAMMATE) && isMain(event.agent)) {
        const task = subagentFor({ id: event.call_id, name: event.name, args: event.args })
        return [...items, { ...task, startedAt: Date.now() }]
      }
      const tool: ToolItem = {
        kind: 'tool',
        id: event.call_id,
        name: event.name,
        args: event.args,
        status: 'running'
      }
      if (!isMain(event.agent)) {
        const i = runningTask(event.agent)
        if (i >= 0) {
          const task = items[i] as Extract<TranscriptItem, { kind: 'subagent' }>
          return replace(i, { ...task, tools: [...task.tools, tool] })
        }
      }
      return [...items, tool]
    }

    case 'tool.result': {
      const patch = (t: ToolItem): ToolItem => ({
        ...t,
        // a call the user turned down reads as rejected, not failed
        status: t.status === 'rejected' && event.status !== 'ok' ? 'rejected' : event.status,
        output: event.output,
        truncated: event.truncated,
        durationMs: event.duration_ms
      })
      const i = items.findIndex((it) => it.id === event.call_id)
      if (i >= 0) {
        const it = items[i]
        if (it.kind === 'tool') return replace(i, patch(it))
        if (it.kind === 'subagent')
          return replace(i, {
            ...it,
            status: event.status === 'ok' ? 'done' : 'error',
            summary: event.output,
            live: undefined,
            liveId: undefined,
            finishedAt: Date.now()
          })
        return items
      }
      // a subagent's own tool
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j]
        if (it.kind !== 'subagent') continue
        const k = it.tools.findIndex((t) => t.id === event.call_id)
        if (k >= 0) {
          const tools = it.tools.slice()
          tools[k] = patch(tools[k])
          return replace(j, { ...it, tools })
        }
      }
      return items
    }

    case 'subagent.started': {
      if (!event.call_id) return items
      const i = items.findIndex((it) => it.kind === 'subagent' && it.id === event.call_id)
      if (i < 0) return items
      const task = items[i] as Extract<TranscriptItem, { kind: 'subagent' }>
      return replace(i, { ...task, name: event.name || task.name })
    }

    case 'approval.required': {
      const ids = new Set(event.requests.map((r) => r.name))
      // mark the paused calls as waiting
      return items.map((it) =>
        it.kind === 'tool' && it.status === 'running' && ids.has(it.name)
          ? { ...it, status: 'waiting' as ToolStatus }
          : it
      )
    }

    case 'notice':
      return [
        ...items,
        { kind: 'notice', id: `notice-${event.run_id}-${event.seq}`, tone: event.tone, text: event.text }
      ]

    case 'compaction':
      return [
        ...items,
        {
          kind: 'notice',
          id: `compaction-${event.run_id}-${event.seq}`,
          tone: 'info',
          text: 'Older messages were summarised to keep the context window clear.'
        }
      ]

    case 'run.finished': {
      let next = items.map((it) =>
        it.kind === 'assistant' && it.streaming ? { ...it, streaming: false } : it
      )
      if (event.status === 'cancelled') {
        next = next.map((it) =>
          it.kind === 'tool' && it.status === 'running'
            ? { ...it, status: 'error' as ToolStatus }
            : it.kind === 'subagent' && it.status === 'running'
              ? { ...it, status: 'error' as const, live: undefined, finishedAt: Date.now() }
              : it
        )
        next.push({ kind: 'notice', id: `end-${event.run_id}`, tone: 'warn', text: 'Stopped.' })
      }
      if (event.status === 'error') {
        next.push({
          kind: 'notice',
          id: `end-${event.run_id}`,
          tone: 'error',
          text: event.error ?? 'The run failed.'
        })
      }
      return next
    }

    default:
      return items
  }
}

// ---------- the store ----------

export const useCoder = create<CoderState>((set, get) => {
  /** Drive a streaming request and fold its events into the store. */
  async function drive(path: string, body: unknown): Promise<void> {
    controller?.abort()
    const ctrl = new AbortController()
    controller = ctrl
    set({ run: 'running', error: null })
    try {
      await stream(path, body, (event) => apply(event), ctrl.signal)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      if (controller === ctrl) controller = null
      if (get().run === 'running') set({ run: 'idle' })
      void get().refreshChanges()
      void refreshSessions()
    }
  }

  function apply(event: CoderEvent): void {
    const state = get()
    const patch: Partial<CoderState> = {
      items: reduce(state.items, event),
      lastSeq: event.seq
    }
    switch (event.type) {
      case 'run.started':
        patch.run = 'running'
        patch.approval = null
        break
      case 'approval.required':
        patch.approval = { interrupt_id: event.interrupt_id, requests: event.requests }
        break
      case 'todos.updated':
        patch.todos = event.todos
        break
      case 'file.changed': {
        const rest = state.changes.filter((c) => c.path !== event.path)
        patch.changes = [...rest, { ...event }].sort((a, b) => a.path.localeCompare(b.path))
        break
      }
      case 'usage':
        patch.usage = {
          session: event.session_total,
          contextTokens: event.context_tokens,
          contextWindow: event.context_window
        }
        break
      case 'run.finished':
        patch.run = event.status === 'awaiting_approval' ? 'awaiting_approval' : 'idle'
        if (event.status !== 'awaiting_approval') patch.approval = null
        break
      case 'research.started':
        patch.researchId = event.session_id
        break
    }
    set(patch)
  }

  async function refreshSessions(): Promise<void> {
    const pid = get().projectId
    if (!pid) return
    const res = await api.projects.sessions(pid)
    if (!res.ok) return
    const sid = get().sessionId
    set({ sessions: res.data, session: res.data.find((s) => s.id === sid) ?? get().session })
  }

  function resetSession(): Partial<CoderState> {
    return {
      sessionId: null,
      session: null,
      items: [],
      todos: [],
      changes: [],
      approval: null,
      run: 'idle',
      usage: { session: EMPTY_USAGE, contextTokens: 0, contextWindow: null },
      lastSeq: -1,
      researchId: null
    }
  }

  function windowFor(model: string): number | null {
    return get().models.find((m) => m.id === model)?.context_window ?? null
  }

  return {
    models: [],
    projects: [],
    projectId: null,
    sessions: [],
    sessionId: null,
    session: null,
    items: [],
    todos: [],
    changes: [],
    approval: null,
    run: 'idle',
    usage: { session: EMPTY_USAGE, contextTokens: 0, contextWindow: null },
    error: null,
    lastSeq: -1,
    researchId: null,
    // Collapsed until asked for: the chat gets the room. Opening a file opens it.
    panelOpen: false,
    panelTab: 'changes',
    openFiles: [],

    async boot() {
      const [models, projects] = await Promise.all([api.models(), api.projects.list()])
      if (models.ok) set({ models: models.data.models })
      if (!projects.ok) {
        set({ error: projects.error })
        return
      }
      set({ projects: projects.data })
      const fromHash = window.location.hash.match(/^#coder\/([\w-]+)/)?.[1] ?? null
      if (fromHash) {
        const s = await api.sessions.get(fromHash)
        if (s.ok && s.data.project_id) {
          await get().selectProject(s.data.project_id)
          await get().openSession(fromHash)
          return
        }
      }
      const last = recall(LAST_PROJECT)
      const pick = projects.data.find((p) => p.id === last) ?? projects.data[0]
      if (pick) await get().selectProject(pick.id)
    },

    async openFolder(path) {
      const res = await api.projects.add(path)
      if (!res.ok) {
        set({ error: res.error })
        return false
      }
      const others = get().projects.filter((p) => p.id !== res.data.id)
      set({ projects: [res.data, ...others] })
      await get().selectProject(res.data.id)
      return true
    },

    async selectProject(id) {
      if (get().projectId === id) return
      controller?.abort()
      remember(LAST_PROJECT, id)
      set({
        projectId: id,
        sessions: [],
        openFiles: [],
        panelTab: get().panelTab.startsWith('file:') ? 'changes' : get().panelTab,
        ...resetSession()
      })
      sessionHash(null)
      await refreshSessions()
    },

    async removeProject(id) {
      await api.projects.remove(id)
      const projects = get().projects.filter((p) => p.id !== id)
      set({ projects })
      if (get().projectId === id) {
        set({ projectId: null, sessions: [], ...resetSession() })
        if (projects[0]) await get().selectProject(projects[0].id)
      }
    },

    async newSession() {
      controller?.abort()
      set({ ...resetSession() })
      sessionHash(null)
    },

    async openSession(id) {
      controller?.abort()
      set({ ...resetSession(), sessionId: id })
      sessionHash(id)
      const [res, changes, research] = await Promise.all([
        api.sessions.transcript(id),
        api.sessions.changes(id),
        api.sessions.research(id)
      ])
      if (get().sessionId !== id) return
      if (!res.ok) {
        set({ error: res.error })
        return
      }
      const t = res.data
      const latest = research.ok
        ? [...research.data].sort((a, b) => b.created_at - a.created_at)[0]
        : undefined
      set({
        session: t.session,
        items: fromWire(t.messages),
        todos: t.todos,
        changes: changes.ok ? changes.data : [],
        researchId: latest?.id ?? null,
        approval: t.pending_approval,
        run: t.pending_approval ? 'awaiting_approval' : t.run_id ? 'running' : 'idle',
        usage: {
          session: t.session.usage,
          contextTokens: t.session.context_tokens,
          contextWindow: windowFor(t.session.model)
        }
      })
      if (t.session.last_error && !t.run_id) {
        set({
          items: [
            ...get().items,
            { kind: 'notice', id: 'last-error', tone: 'error', text: t.session.last_error }
          ]
        })
      }
      // Still running (e.g. the window was reloaded): follow it live.
      if (t.run_id) {
        const { path } = streams.events(id, -1)
        // replay from the start of the run on top of the stored transcript
        const base = get().items
        set({ items: base })
        await drive(path, undefined)
      }
    },

    async deleteSession(id) {
      await api.sessions.remove(id)
      if (get().sessionId === id) {
        set({ ...resetSession() })
        sessionHash(null)
      }
      await refreshSessions()
    },

    async send(text) {
      const trimmed = text.trim()
      if (!trimmed || get().run !== 'idle') return
      let sid = get().sessionId
      if (!sid) {
        const pid = get().projectId
        if (!pid) return
        const draft = get().session
        const created = await api.sessions.create({
          project_id: pid,
          model: draft?.model,
          reasoning_effort: draft?.reasoning_effort ?? undefined,
          mode: draft?.mode
        })
        if (!created.ok) {
          set({ error: created.error })
          return
        }
        sid = created.data.id
        const firstLine = trimmed.split('\n')[0]
        set({
          sessionId: sid,
          // the server titles a session from its first message; show it now
          session: {
            ...created.data,
            title: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
          },
          usage: { ...get().usage, contextWindow: windowFor(created.data.model) }
        })
        sessionHash(sid)
      }
      set({
        items: [...get().items, { kind: 'user', id: `local-${Date.now()}`, text: trimmed }]
      })
      const { path, body } = streams.message(sid, trimmed)
      await drive(path, body)
    },

    async decide(decisions, rememberRules = []) {
      const sid = get().sessionId
      const approval = get().approval
      if (!sid || !approval) return
      // Mark the paused calls the user turned down, in request order.
      const rejected = new Set(
        approval.requests.filter((_, i) => decisions[i]?.type === 'reject').map((r) => r.name)
      )
      set({
        approval: null,
        items: get().items.map((it) =>
          it.kind === 'tool' && it.status === 'waiting' && rejected.has(it.name)
            ? { ...it, status: 'rejected' as ToolStatus }
            : it
        )
      })
      const { path, body } = streams.decisions(sid, decisions, rememberRules)
      await drive(path, body)
    },

    async cancel() {
      const sid = get().sessionId
      if (!sid) return
      await api.sessions.cancel(sid)
    },

    async setMode(mode) {
      const s = get().session
      const sid = get().sessionId
      if (!sid) {
        // No session yet: remember the choice for the first message.
        const pid = get().projectId
        const model = s?.model ?? get().projects.find((p) => p.id === pid)?.settings.default_model
        set({ session: draftSession(pid, model ?? '', mode, s) })
        return
      }
      const res = await api.sessions.update(sid, { mode })
      if (res.ok) set({ session: res.data })
      else set({ error: res.error })
    },

    async setModel(model) {
      const s = get().session
      const sid = get().sessionId
      if (!sid) {
        const pid = get().projectId
        const mode = s?.mode ?? get().projects.find((p) => p.id === pid)?.settings.default_mode
        set({
          session: draftSession(pid, model, mode ?? 'supervised', s),
          usage: { ...get().usage, contextWindow: windowFor(model) }
        })
        return
      }
      const res = await api.sessions.update(sid, { model })
      if (res.ok) {
        set({ session: res.data, usage: { ...get().usage, contextWindow: windowFor(model) } })
      } else set({ error: res.error })
    },

    async setEffort(effort) {
      const s = get().session
      const sid = get().sessionId
      if (!sid) {
        const pid = get().projectId
        const project = get().projects.find((p) => p.id === pid)
        const draft = draftSession(
          pid,
          s?.model ?? project?.settings.default_model ?? '',
          s?.mode ?? project?.settings.default_mode ?? 'supervised',
          s
        )
        set({ session: { ...draft, reasoning_effort: effort } })
        return
      }
      const res = await api.sessions.update(sid, { reasoning_effort: effort })
      if (res.ok) set({ session: res.data })
      else set({ error: res.error })
    },

    async refreshChanges() {
      const sid = get().sessionId
      if (!sid) return
      const res = await api.sessions.changes(sid)
      if (res.ok && get().sessionId === sid) set({ changes: res.data })
    },

    async acceptChanges(paths = []) {
      const sid = get().sessionId
      if (!sid) return
      const res = await api.sessions.accept(sid, paths)
      if (res.ok) set({ changes: res.data })
      else set({ error: res.error })
    },

    async revertChanges(paths = []) {
      const sid = get().sessionId
      if (!sid) return
      const res = await api.sessions.revert(sid, paths)
      if (res.ok) set({ changes: res.data })
      else set({ error: res.error })
    },

    async generateGuide() {
      const pid = get().projectId
      if (!pid) return
      const res = await api.projects.init(pid)
      if (!res.ok) {
        set({ error: res.error })
        return
      }
      await refreshSessions()
      await get().openSession(res.data.id)
    },

    async researchNow() {
      const sid = get().sessionId
      if (!sid) return
      const res = await api.sessions.researchNow(sid)
      if (res.ok) set({ researchId: res.data.id })
      else set({ error: res.error })
    },

    async setAutoResearch(on) {
      const pid = get().projectId
      if (!pid) return
      const res = await api.projects.update(pid, { auto_research: on })
      if (res.ok) set({ projects: get().projects.map((p) => (p.id === pid ? res.data : p)) })
      else set({ error: res.error })
    },

    clearError() {
      set({ error: null })
    },

    setPanelOpen(open) {
      set({ panelOpen: open })
    },

    setPanelTab(tab) {
      set({ panelTab: tab, panelOpen: true })
    },

    openFile(path) {
      const clean = path.replace(/^\/+/, '')
      if (!clean) return
      const open = get().openFiles
      set({
        openFiles: open.includes(clean) ? open : [...open, clean],
        panelTab: `file:${clean}`,
        panelOpen: true
      })
    },

    closeFile(path) {
      const open = get().openFiles
      const i = open.indexOf(path)
      if (i < 0) return
      const rest = open.filter((p) => p !== path)
      let tab = get().panelTab
      if (tab === `file:${path}`) {
        // Land on the neighbouring file, or back on Changes.
        const next = rest[Math.min(i, rest.length - 1)]
        tab = next ? `file:${next}` : 'changes'
      }
      set({ openFiles: rest, panelTab: tab })
    }
  }
})

/** A not-yet-created session, holding the model and mode the user picked. */
function draftSession(
  projectId: string | null,
  model: string,
  mode: PermissionMode,
  prev: Session | null
): Session {
  const now = Date.now() / 1000
  return {
    id: '',
    project_id: projectId,
    agent_id: 'coder',
    parent_session_id: null,
    group_id: null,
    members: null,
    title: '',
    model,
    reasoning_effort: prev?.reasoning_effort ?? null,
    mode,
    created_at: prev?.created_at ?? now,
    updated_at: now,
    status: 'idle',
    usage: EMPTY_USAGE,
    context_tokens: 0,
    last_error: null
  }
}
