import { create } from 'zustand'
import type { ChatTurn, KnowledgeEvent, KnowledgeSource } from '../../../shared/contracts'
import { stream } from '../sse'

/** One message in a knowledge base's conversation. */
export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** The passages the answer may cite as `[n]`. */
  sources: KnowledgeSource[]
  state: 'streaming' | 'done' | 'stopped' | 'error'
  error?: string
}

interface KnowledgeChat {
  /** Each base's conversation, kept for the session. */
  threads: Record<string, Turn[]>
  send: (baseId: string, text: string) => Promise<void>
  stop: (baseId: string) => void
  /** Start the conversation over. */
  clear: (baseId: string) => void
}

/** How much of the conversation goes back with each question. */
const HISTORY_TURNS = 12

const controllers = new Map<string, AbortController>()

let seq = 0
const nextId = (): string => `t${Date.now().toString(36)}${(seq++).toString(36)}`

function reason(err: unknown): string {
  if (err instanceof TypeError) return 'Polly could not reach the agent server.'
  return err instanceof Error ? err.message : String(err)
}

export const useKnowledgeChat = create<KnowledgeChat>((set, get) => ({
  threads: {},

  async send(baseId, text) {
    if (controllers.has(baseId) || !text.trim()) return
    const prior = get().threads[baseId] ?? []
    const history: ChatTurn[] = prior
      .filter((t) => t.text.trim() && (t.role === 'user' || t.state !== 'error'))
      .slice(-HISTORY_TURNS)
      .map((t) => ({ role: t.role, text: t.text }))

    const question: Turn = { id: nextId(), role: 'user', text, sources: [], state: 'done' }
    const answer: Turn = {
      id: nextId(),
      role: 'assistant',
      text: '',
      sources: [],
      state: 'streaming'
    }
    set((s) => ({ threads: { ...s.threads, [baseId]: [...prior, question, answer] } }))

    const update = (change: (t: Turn) => Turn): void =>
      set((s) => ({
        threads: {
          ...s.threads,
          [baseId]: (s.threads[baseId] ?? []).map((t) => (t.id === answer.id ? change(t) : t))
        }
      }))

    const controller = new AbortController()
    controllers.set(baseId, controller)
    try {
      await stream<KnowledgeEvent>(
        `/knowledge/${encodeURIComponent(baseId)}/chat`,
        { message: text, history },
        (event) => {
          // Sources come first, then again before `done` with only the cited ones: each replaces the last.
          if (event.type === 'sources') update((t) => ({ ...t, sources: event.sources }))
          else if (event.type === 'delta') update((t) => ({ ...t, text: t.text + event.text }))
          else if (event.type === 'done')
            update((t) => ({ ...t, text: event.text || t.text, state: 'done' }))
          else if (event.type === 'error')
            update((t) => ({ ...t, state: 'error', error: event.message }))
        },
        controller.signal
      )
      update((t) => (t.state === 'streaming' ? { ...t, state: 'done' } : t))
    } catch (err) {
      if (controller.signal.aborted) update((t) => ({ ...t, state: 'stopped' }))
      else update((t) => ({ ...t, state: 'error', error: reason(err) }))
    } finally {
      controllers.delete(baseId)
    }
  },

  stop(baseId) {
    controllers.get(baseId)?.abort()
  },

  clear(baseId) {
    controllers.get(baseId)?.abort()
    set((s) => {
      const { [baseId]: _, ...rest } = s.threads
      return { threads: rest }
    })
  }
}))
