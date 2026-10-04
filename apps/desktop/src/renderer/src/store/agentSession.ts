import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type {
  ChangeReport,
  CoderEvent,
  PRFacts,
  Scorecard,
  Session,
  Source
} from '../../../shared/contracts'
import { api, streams } from '../api'
import { stream } from '../sse'
import { fromWire, reduce, type RunState, type TranscriptItem } from './coder'

/**
 * A chat with one of the agents that run without a project: the Researcher,
 * Deep Research, the Reviewer, the change research a Coder run hands off, the
 * agents people make themselves, and groups of them. Each page gets its own
 * store from `createAgentStore`.
 */
export interface AgentSessionState {
  /** The agents (or groups) this store lists sessions for; the first is the default. */
  agentIds: string[]
  /** The agent (or group) a new session starts with. */
  agentId: string
  sessions: Session[]
  sessionId: string | null
  session: Session | null
  items: TranscriptItem[]
  run: RunState
  error: string | null
  /** Fetching a PR before the review starts. */
  starting: boolean
  /**
   * The teammates picked for the open conversation, or for the one about to
   * start; null follows the agent's own team.
   */
  members: string[] | null

  sources: Source[]
  report: ChangeReport | null
  scorecard: Scorecard | null
  pr: PRFacts | null

  boot: () => Promise<void>
  refresh: () => Promise<void>
  setAgent: (id: string) => void
  /** Replace the agents this store covers (custom agents come and go). */
  setAgentIds: (ids: string[]) => void
  newSession: () => void
  open: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** `mentions`: agents addressed with `@Name`; they join the conversation's team. */
  send: (text: string, mentions?: string[]) => Promise<void>
  /** Choose the conversation's teammates. */
  setMembers: (ids: string[]) => Promise<void>
  cancel: () => Promise<void>
  review: (prUrl: string) => Promise<boolean>
  clearError: () => void
}

interface Options {
  agentIds: string[]
  /** `group`: the ids are groups, and a conversation runs with the group's lead. */
  scope?: 'agent' | 'group'
  /** `research` keeps the open session in `#research/<id>`; null leaves the URL alone. */
  hash: string | null
  /** Sees every event of the open session (the Designer's canvas follows along). */
  onEvent?: (event: CoderEvent, sessionId: string) => void
  /** Runs before a message is sent, once the session exists. */
  beforeSend?: (sessionId: string) => Promise<void>
}

export type AgentStore = UseBoundStore<StoreApi<AgentSessionState>>

export function createAgentStore({
  agentIds,
  scope = 'agent',
  hash,
  onEvent,
  beforeSend
}: Options): AgentStore {
  return create<AgentSessionState>((set, get) => {
    let controller: AbortController | null = null
    /** Which of this store's agents (or groups) a session belongs to. */
    const ownerOf = (s: Session): string => (scope === 'group' ? (s.group_id ?? '') : s.agent_id)

    function setHash(id: string | null): void {
      if (!hash || !window.location.hash.startsWith(`#${hash}`)) return
      const next = id ? `#${hash}/${id}` : `#${hash}`
      if (window.location.hash !== next) window.history.replaceState(null, '', next)
    }

    function empty(): Partial<AgentSessionState> {
      return {
        sessionId: null,
        session: null,
        items: [],
        run: 'idle',
        members: null,
        sources: [],
        report: null,
        scorecard: null,
        pr: null
      }
    }

    function apply(event: CoderEvent): void {
      const state = get()
      // In a group the store's id is the group's; the one talking is its lead.
      const main = state.session?.agent_id ?? state.agentId
      const patch: Partial<AgentSessionState> = { items: reduce(state.items, event, main) }
      switch (event.type) {
        case 'run.started':
          patch.run = 'running'
          break
        case 'run.finished':
          patch.run = 'idle'
          break
        case 'sources.added': {
          const known = new Set(state.sources.map((s) => s.id))
          const fresh = event.sources.filter((s) => !known.has(s.id))
          if (fresh.length) patch.sources = [...state.sources, ...fresh].sort((a, b) => a.id - b.id)
          break
        }
        case 'report':
          patch.report = event.report
          break
        case 'scorecard':
          patch.scorecard = event.scorecard
          break
      }
      set(patch)
      if (onEvent && state.sessionId) onEvent(event, state.sessionId)
    }

    async function loadArtifacts(id: string): Promise<void> {
      const res = await api.sessions.artifacts(id)
      if (!res.ok || get().sessionId !== id) return
      set({
        sources: res.data.sources,
        report: res.data.report,
        scorecard: res.data.scorecard,
        pr: res.data.pr
      })
    }

    async function drive(path: string, body: unknown, id: string): Promise<void> {
      controller?.abort()
      const ctrl = new AbortController()
      controller = ctrl
      set({ run: 'running', error: null })
      try {
        await stream(path, body, apply, ctrl.signal)
      } catch (err) {
        if (!ctrl.signal.aborted) set({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (controller === ctrl) controller = null
        if (get().sessionId === id) {
          if (get().run === 'running') set({ run: 'idle' })
          void loadArtifacts(id)
        }
        void get().refresh()
      }
    }

    return {
      agentIds,
      agentId: agentIds[0] ?? '',
      sessions: [],
      sessionId: null,
      session: null,
      items: [],
      run: 'idle',
      error: null,
      starting: false,
      members: null,
      sources: [],
      report: null,
      scorecard: null,
      pr: null,

      async boot() {
        await get().refresh()
        const fromHash = hash
          ? (window.location.hash.match(new RegExp(`^#${hash}/([\\w-]+)`))?.[1] ?? null)
          : null
        if (fromHash && fromHash !== get().sessionId) await get().open(fromHash)
      },

      async refresh() {
        if (!hash) return // change research is listed by its Coder session
        const ids = get().agentIds
        const list = scope === 'group' ? api.sessions.listGroup : api.sessions.list
        const lists = await Promise.all(ids.map((id) => list(id)))
        const failed = lists.find((r) => !r.ok)
        if (failed && !failed.ok) {
          set({ error: failed.error })
          return
        }
        if (get().agentIds !== ids) return // the agents changed while this was loading
        const sessions = lists
          .flatMap((r) => (r.ok ? r.data : []))
          .sort((a, b) => b.updated_at - a.updated_at)
        const sid = get().sessionId
        const session = sessions.find((s) => s.id === sid) ?? get().session
        // A teammate addressed with @ joined the conversation on the server.
        set({ sessions, session, ...(session && sid ? { members: session.members } : {}) })
      },

      setAgent(id) {
        if (get().agentIds.includes(id)) set({ agentId: id })
      },

      setAgentIds(ids) {
        const current = get().agentIds
        if (ids.length === current.length && ids.every((id, i) => id === current[i])) return
        const agentId = ids.includes(get().agentId) ? get().agentId : (ids[0] ?? '')
        set({ agentIds: ids, agentId })
        // The open conversation belonged to an agent that is gone.
        const open = get().session
        if (open && !ids.includes(ownerOf(open))) get().newSession()
        void get().refresh()
      },

      newSession() {
        controller?.abort()
        set({ ...empty(), error: null })
        setHash(null)
      },

      async open(id) {
        if (get().sessionId === id && controller) return
        controller?.abort()
        set({ ...empty(), sessionId: id, error: null })
        setHash(id)
        const [res, artifacts] = await Promise.all([
          api.sessions.transcript(id),
          api.sessions.artifacts(id)
        ])
        if (get().sessionId !== id) return
        if (!res.ok) {
          set({ error: res.error })
          return
        }
        const t = res.data
        const items = fromWire(t.messages)
        if (t.session.last_error && !t.run_id)
          items.push({ kind: 'notice', id: 'last-error', tone: 'error', text: t.session.last_error })
        set({
          session: t.session,
          members: t.session.members,
          agentId: get().agentIds.includes(ownerOf(t.session))
            ? ownerOf(t.session)
            : get().agentId,
          items,
          run: t.run_id ? 'running' : 'idle',
          ...(artifacts.ok
            ? {
                sources: artifacts.data.sources,
                report: artifacts.data.report,
                scorecard: artifacts.data.scorecard,
                pr: artifacts.data.pr
              }
            : {})
        })
        if (t.run_id) {
          // Still running (a review, change research, or a reload): follow it live.
          const { path } = streams.events(id, -1)
          void drive(path, undefined, id)
        }
      },

      async remove(id) {
        await api.sessions.remove(id)
        if (get().sessionId === id) get().newSession()
        await get().refresh()
      },

      async setMembers(ids) {
        const sid = get().sessionId
        const before = get().members
        set({ members: ids })
        if (!sid) return // kept for the conversation about to start
        const res = await api.sessions.update(sid, { members: ids })
        if (get().sessionId !== sid) return
        if (res.ok) set({ session: res.data, members: res.data.members })
        else set({ members: before, error: res.error })
      },

      async send(text, mentions = []) {
        const trimmed = text.trim()
        if (!trimmed || get().run !== 'idle') return
        let sid = get().sessionId
        if (!sid) {
          const firstLine = trimmed.split('\n')[0]
          const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
          const created = await api.sessions.create(
            scope === 'group'
              ? { group_id: get().agentId, title }
              : { agent_id: get().agentId, title, members: get().members ?? undefined }
          )
          if (!created.ok) {
            set({ error: created.error })
            return
          }
          sid = created.data.id
          set({ sessionId: sid, session: created.data })
          setHash(sid)
        }
        set({ items: [...get().items, { kind: 'user', id: `local-${Date.now()}`, text: trimmed }] })
        if (beforeSend) await beforeSend(sid)
        const { path, body } = streams.message(sid, trimmed, mentions)
        await drive(path, body, sid)
      },

      async cancel() {
        const sid = get().sessionId
        if (sid) await api.sessions.cancel(sid)
      },

      async review(prUrl) {
        const url = prUrl.trim()
        if (!url || get().starting) return false
        set({ starting: true, error: null })
        const res = await api.reviews.create(url)
        set({ starting: false })
        if (!res.ok) {
          set({ error: res.error })
          return false
        }
        await get().refresh()
        await get().open(res.data.id)
        return true
      },

      clearError() {
        set({ error: null })
      }
    }
  })
}

export const useResearch = createAgentStore({
  agentIds: ['researcher', 'deep-research'],
  hash: 'research'
})

export const useReview = createAgentStore({ agentIds: ['reviewer'], hash: 'review' })

/** Conversations with custom agents; `App` keeps its agents in step with the server. */
export const useChat = createAgentStore({ agentIds: [], hash: 'chat' })

/** Conversations with groups of agents; `App` keeps its groups in step with the server. */
export const useGroupChat = createAgentStore({ agentIds: [], scope: 'group', hash: 'group' })

/** Change research for the open Coder session, shown in the Inspector. */
export const useChangeResearch = createAgentStore({ agentIds: ['change-research'], hash: null })
