import type {
  ChatTurn,
  CopilotChip,
  CopilotEvent,
  CopilotSettings,
  HintKind,
  KnowledgeBase,
  TodoFields,
  TodoItem
} from '../../../shared/contracts'
import type { Snapshot } from '../../../shared/sense'
import { request } from '../api'
import { stream } from '../sse'

/** The copilot's calls to the agent server. */

type OnEvent = (event: CopilotEvent) => void

export const copilotApi = {
  settings: () => request<CopilotSettings>('GET', '/copilot/settings'),
  updateSettings: (patch: Partial<CopilotSettings>) =>
    request<CopilotSettings>('PATCH', '/copilot/settings', patch),

  observe: (
    trigger: 'switch' | 'typing' | 'content' | 'visual' | 'open',
    snapshot: Snapshot,
    onEvent: OnEvent,
    signal: AbortSignal
  ) => stream<CopilotEvent>('/copilot/observe', { trigger, snapshot }, onEvent, signal),

  act: (
    chip: CopilotChip,
    snapshot: Snapshot,
    kbIds: string[],
    onEvent: OnEvent,
    signal: AbortSignal
  ) => stream<CopilotEvent>('/copilot/act', { chip, snapshot, kb_ids: kbIds }, onEvent, signal),

  ask: (
    message: string,
    history: ChatTurn[],
    snapshot: Snapshot | null,
    kbIds: string[],
    onEvent: OnEvent,
    signal: AbortSignal
  ) =>
    stream<CopilotEvent>(
      '/copilot/ask',
      { message, history, snapshot, kb_ids: kbIds },
      onEvent,
      signal
    ),

  rewrite: (
    body: { text: string; instruction: string; token: string | null; app: string | null },
    onEvent: OnEvent,
    signal: AbortSignal
  ) => stream<CopilotEvent>('/copilot/rewrite', body, onEvent, signal),

  feedback: (body: {
    kind: 'ignore' | 'mute' | 'apply' | 'todo_ignored' | 'todo_accepted'
    lens?: string
    hint_kind?: HintKind
    title?: string
  }) => request<void>('POST', '/copilot/feedback', body),

  addTodo: (fields: TodoFields) => request<TodoItem>('POST', '/todos', fields),
  openTodos: async () => {
    const res = await request<{ todos: TodoItem[] }>('GET', '/todos?status=open')
    return res.ok ? res.data.todos : []
  },
  dueTodos: async () => {
    const res = await request<{ todos: TodoItem[] }>('GET', '/todos/due')
    return res.ok ? res.data.todos : []
  },
  reminded: (id: string) => request<void>('POST', `/todos/${id}/reminded`),
  snooze: (id: string, minutes: number) =>
    request<TodoItem>('POST', `/todos/${id}/snooze`, { minutes }),
  completeTodo: (id: string) => request<TodoItem>('PATCH', `/todos/${id}`, { status: 'done' }),

  knowledgeBases: async (): Promise<KnowledgeBase[]> => {
    const res = await request<{ bases: KnowledgeBase[] }>('GET', '/knowledge')
    return res.ok ? res.data.bases : []
  }
}
