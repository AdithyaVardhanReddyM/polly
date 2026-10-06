import { create } from 'zustand'
import type {
  ApplyPlan,
  CopilotChip,
  CopilotContext,
  HintKind,
  KnowledgeBase,
  KnowledgeSource,
  RecallHit,
  TodoItem,
  TodoProposal
} from '../../../shared/contracts'
import type { CopilotState } from '../../../shared/copilot'
import type { SenseApp, Snapshot } from '../../../shared/sense'

/** One suggestion or answer in the island. */
export interface Card {
  id: string
  kind: HintKind
  title: string
  /** Offered without being asked (a hint), as opposed to a chip or a question. */
  proactive: boolean
  /** Markdown; while streaming, the raw text so far. */
  text: string
  suggestion: string | null
  apply: ApplyPlan | null
  done: boolean
  /** What the copilot is doing right now ("Looking at the window…"). */
  status: string | null
  lens: string
  /** The app the suggestion belongs in. */
  app: SenseApp | null
  applied: 'idle' | 'applying' | 'applied' | 'failed'
  recall: RecallHit[]
  sources: KnowledgeSource[]
  error: string | null
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
  card?: Card
}

export interface Peek {
  text: string
  until: number
  tone: 'info' | 'hint' | 'todo' | 'reminder'
}

interface NotchState {
  copilot: CopilotState | null
  hovering: boolean
  pinned: boolean
  /** The text field has focus: the island stays open while the user types. */
  typing: boolean
  peek: Peek | null

  context: CopilotContext | null
  /** The app in front when privacy settings keep the copilot out of it. */
  excluded: { app: string; reason: string } | null
  appIcon: string | null
  chips: CopilotChip[]
  /** Reading the screen or thinking: shown as a quiet status line. */
  busy: string | null
  card: Card | null
  /** The conversation from the island's text field. */
  thread: Turn[]
  proposals: TodoProposal[]
  reminders: TodoItem[]
  lastSnapshot: Snapshot | null
  serverDown: boolean

  bases: KnowledgeBase[]
  attached: string[]

  set: (patch: Partial<NotchState>) => void
  updateCard: (id: string, patch: Partial<Card> | ((card: Card) => Partial<Card>)) => void
}

export const useNotch = create<NotchState>((set) => ({
  copilot: null,
  hovering: false,
  pinned: false,
  typing: false,
  peek: null,
  context: null,
  excluded: null,
  appIcon: null,
  chips: [],
  busy: null,
  card: null,
  thread: [],
  proposals: [],
  reminders: [],
  lastSnapshot: null,
  serverDown: false,
  bases: [],
  attached: [],

  set: (patch) => set(patch),
  updateCard: (id, patch) =>
    set((state) => {
      const apply = (card: Card): Card =>
        card.id === id ? { ...card, ...(typeof patch === 'function' ? patch(card) : patch) } : card
      return {
        card: state.card ? apply(state.card) : null,
        thread: state.thread.map((turn) => (turn.card ? { ...turn, card: apply(turn.card) } : turn))
      }
    })
}))

export function newCard(partial: Partial<Card> & Pick<Card, 'id' | 'kind' | 'title'>): Card {
  return {
    proactive: false,
    text: '',
    suggestion: null,
    apply: null,
    done: false,
    status: null,
    lens: 'generic',
    app: null,
    applied: 'idle',
    recall: [],
    sources: [],
    error: null,
    ...partial
  }
}
