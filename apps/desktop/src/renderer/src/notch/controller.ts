import type {
  ApplyPlan,
  ChatTurn,
  CopilotChip,
  CopilotEvent,
  CopilotSettings,
  TodoProposal
} from '../../../shared/contracts'
import type { CopilotState } from '../../../shared/copilot'
import type { Rect, SenseApp, SenseEvent, Snapshot, TextBlock } from '../../../shared/sense'
import { copilotApi } from './api'
import { type Card, newCard, type Peek, type Turn, useNotch } from './store'

/**
 * What the island does with what the helper sees, and with what the user
 * clicks. The helper sends events (app switched, typing paused, new content,
 * selection); we take a snapshot of the window, post it to the server and
 * show what comes back. Every read goes through the main process, which
 * refuses while the copilot is off.
 */

const bridge = window.polly?.copilot

type Trigger = 'switch' | 'typing' | 'content' | 'visual' | 'open'

// Lower number wins when two triggers are waiting.
const PRIORITY: Record<Trigger, number> = { switch: 0, open: 1, typing: 2, content: 3, visual: 4 }
// Content and visual changes are frequent; space them out.
const SPACING: Partial<Record<Trigger, number>> = { content: 6000, visual: 12000 }

let observing: AbortController | null = null
let acting: AbortController | null = null
let waiting: { trigger: Trigger; timer: ReturnType<typeof setTimeout> } | null = null
const lastRun: Partial<Record<Trigger, number>> = {}
let lastFingerprint = ''
let currentWindow = ''
let settings: CopilotSettings | null = null
const icons = new Map<string, string | null>()

const get = useNotch.getState
const set = (patch: Parameters<ReturnType<typeof get>['set']>[0]): void => get().set(patch)

// ---------- start ----------

export async function init(): Promise<void> {
  if (!bridge) return
  set({ copilot: await bridge.state() })
  bridge.onState(stateChanged)
  bridge.onSense(senseEvent)
  bridge.onHover((inside) => {
    set({ hovering: inside })
    if (inside) opened()
  })
  await connect()
  setInterval(() => void connect(), 60_000)
  setInterval(() => void pollReminders(), 30_000)
  void pollReminders()
}

/** Loads what the island needs from the server; tells the helper about exclusions. */
async function connect(): Promise<void> {
  const res = await copilotApi.settings()
  if (!res.ok) {
    set({ serverDown: true })
    return
  }
  const first = settings === null
  settings = res.data
  set({ serverDown: false, bases: await copilotApi.knowledgeBases() })
  if (first) await bridge?.privacyChanged()
}

function stateChanged(next: CopilotState): void {
  const before = get().copilot
  set({ copilot: next })
  if (!before || before.watching === next.watching) return
  if (next.watching) {
    peek(`Watching · ${next.shortcut} to stop`, 'info', 2600)
    lastFingerprint = ''
    currentWindow = ''
    schedule('switch', 250)
  } else {
    stopAll()
    const card = get().card
    set({
      context: null,
      chips: [],
      busy: null,
      excluded: null,
      proposals: [],
      card: card && !card.proactive ? card : null
    })
    peek('Stopped watching', 'info', 1800)
  }
}

function stopAll(): void {
  observing?.abort()
  observing = null
  if (waiting) clearTimeout(waiting.timer)
  waiting = null
  bridge?.overlay({ bubble: null, glow: null, highlights: null })
}

export function toggleWatching(): void {
  const state = get().copilot
  if (state) void bridge?.setWatching(!state.watching)
}

/** Hovering the island with nothing on it yet: read the window now. */
function opened(): void {
  const { copilot, context } = get()
  if (copilot?.watching && !context && !observing) schedule('open', 0)
}

// ---------- events from the helper ----------

function senseEvent(event: SenseEvent): void {
  switch (event.event) {
    case 'app':
    case 'focus': {
      const { app, window, excluded } = event.data
      const key = `${app.bundleId}|${window.title}`
      if (excluded) {
        shutOut(app.name, 'privacy settings')
        currentWindow = key
        return
      }
      // Focus moving between elements of the same window is not a new context.
      if (key === currentWindow && event.event === 'focus') return
      currentWindow = key
      set({ excluded: null })
      schedule('switch', 450)
      return
    }
    case 'typing':
      if (!event.data.excluded) schedule('typing', 0)
      return
    case 'content':
    case 'visual':
      if (!event.data.excluded) schedule(event.event, 0)
      return
    case 'selection':
      selectionChanged(event.data)
      return
    default:
      return
  }
}

// Polly's own windows are never read, and don't need saying so.
const SELF = /^(Polly|Electron)$/

function shutOut(app: string, reason: string): void {
  observing?.abort()
  const card = get().card
  set({
    excluded: SELF.test(app) || reason === 'self' ? null : { app, reason },
    context: null,
    chips: [],
    busy: null,
    card: card && !card.proactive ? card : null
  })
  bridge?.overlay({ bubble: null })
}

function schedule(trigger: Trigger, delay: number): void {
  if (waiting && PRIORITY[waiting.trigger] < PRIORITY[trigger]) return
  const spacing = SPACING[trigger]
  if (spacing && Date.now() - (lastRun[trigger] ?? 0) < spacing) return
  if (waiting) clearTimeout(waiting.timer)
  waiting = {
    trigger,
    timer: setTimeout(() => {
      waiting = null
      void observe(trigger)
    }, delay)
  }
}

/** A cheap summary of what a snapshot says, to skip posting the same screen twice. */
function fingerprint(snap: Snapshot): string {
  if (snap.excluded) return 'excluded'
  const text = [
    snap.window.title,
    snap.url,
    snap.focused?.value ?? '',
    snap.ax.map((b) => b.text).join('\n'),
    (snap.ocr ?? []).map((b) => b.text).join('\n')
  ].join('\u0000')
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return `${text.length}:${hash}`
}

async function observe(trigger: Trigger): Promise<void> {
  if (!bridge || !get().copilot?.watching) return
  lastRun[trigger] = Date.now()
  observing?.abort()
  const control = new AbortController()
  observing = control
  if (trigger === 'switch' || trigger === 'open') set({ busy: 'Reading this window…' })

  const snap = await bridge.snapshot({ ocr: 'auto', screenshot: trigger !== 'typing' })
  if (control.signal.aborted) return
  if (!snap) {
    set({ busy: null })
    observing = null
    return
  }
  if (snap.excluded) {
    shutOut(snap.app.name, snap.reason)
    observing = null
    return
  }
  const print = fingerprint(snap)
  if (trigger !== 'switch' && trigger !== 'open' && print === lastFingerprint) {
    set({ busy: null })
    observing = null
    return
  }
  lastFingerprint = print
  set({ lastSnapshot: snap, excluded: null })
  void loadIcon(snap.app.bundleId)
  if (snap.screenshot && snap.window.frame) glow(snap.window.frame, 900)

  try {
    await copilotApi.observe(trigger, snap, (event) => observed(event, snap), control.signal)
    set({ serverDown: false })
  } catch (err) {
    if (!control.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err)
      if (/fetch|network|unreachable/i.test(message)) set({ serverDown: true })
      console.warn('[copilot] observe failed', message)
    }
  } finally {
    if (observing === control) {
      observing = null
      set({ busy: null })
    }
  }
}

function observed(event: CopilotEvent, snap: Snapshot): void {
  if (snap.excluded) return
  switch (event.type) {
    case 'context':
      set({ context: event.context })
      return
    case 'chips':
      set({ chips: event.chips })
      return
    case 'todo':
      propose(event.todo, snap)
      return
    case 'card.start': {
      const current = get().card
      // Never replace something the user asked for, or is applying, with a hint.
      if (current && (!current.proactive || current.applied === 'applying')) return
      set({
        card: newCard({
          id: event.id,
          kind: event.kind,
          title: event.title,
          proactive: true,
          lens: get().context?.lens ?? 'generic',
          app: snap.app,
          status: null
        }),
        busy: null
      })
      if (!isOpen()) peek(event.title, 'hint', 6000)
      return
    }
    case 'card.delta':
      get().updateCard(event.id, (card) => ({ text: card.text + event.text }))
      return
    case 'card.done':
      get().updateCard(event.id, {
        text: event.text,
        suggestion: event.suggestion,
        apply: event.apply,
        done: true
      })
      return
    case 'error':
      console.warn('[copilot] server:', event.message)
      return
    default:
      return
  }
}

// ---------- what the user does ----------

function isOpen(): boolean {
  const { hovering, pinned, typing } = get()
  return hovering || pinned || typing
}

export async function runChip(chip: CopilotChip): Promise<void> {
  if (!bridge) return
  acting?.abort()
  const control = new AbortController()
  acting = control
  const localId = `local-${Date.now()}`
  const before = get().lastSnapshot
  set({
    card: newCard({
      id: localId,
      kind: 'answer',
      title: chip.label,
      status: 'Reading this window…',
      lens: get().context?.lens ?? 'generic',
      app: before && !before.excluded ? before.app : null
    })
  })
  const fresh = await bridge.snapshot({ ocr: 'auto', screenshot: true })
  const snap = fresh ?? before
  if (!snap || snap.excluded) {
    get().updateCard(localId, {
      status: null,
      done: true,
      error: get().copilot?.watching
        ? "Polly can't see this window."
        : `Turn the copilot on (${get().copilot?.shortcut ?? '⌃⌥P'}) so Polly can see this window.`
    })
    return
  }
  if (snap.window.frame) glow(snap.window.frame, 1200)
  get().updateCard(localId, { status: 'Thinking…', app: snap.app })
  await follow(localId, control, (onEvent) =>
    copilotApi.act(chip, snap, get().attached, onEvent, control.signal)
  , snap)
}

export async function ask(message: string): Promise<void> {
  const text = message.trim()
  if (!text || !bridge) return
  acting?.abort()
  const control = new AbortController()
  acting = control
  const localId = `local-${Date.now()}`
  const history: ChatTurn[] = get().thread.map((turn) => ({
    role: turn.role,
    text: turn.card
      ? [turn.card.text, turn.card.suggestion].filter(Boolean).join('\n\n')
      : turn.text
  }))
  const watching = get().copilot?.watching
  const card = newCard({
    id: localId,
    kind: 'answer',
    title: text,
    status: watching ? 'Reading this window…' : 'Thinking…',
    lens: get().context?.lens ?? 'generic'
  })
  set({ thread: [...get().thread, { role: 'user', text }, { role: 'assistant', text: '', card }] })
  const snap = watching ? await bridge.snapshot({ ocr: 'auto', screenshot: true }) : null
  const usable = snap && !snap.excluded ? snap : null
  get().updateCard(localId, { status: 'Thinking…', app: usable?.app ?? null })
  await follow(localId, control, (onEvent) =>
    copilotApi.ask(text, history, usable, get().attached, onEvent, control.signal)
  , usable)
}

/** Streams an action or answer into the card with `localId`. */
async function follow(
  localId: string,
  control: AbortController,
  start: (onEvent: (event: CopilotEvent) => void) => Promise<void>,
  snap: Snapshot | null
): Promise<void> {
  let id = localId
  try {
    await start((event) => {
      switch (event.type) {
        case 'card.start':
          get().updateCard(id, { id: event.id, kind: event.kind })
          id = event.id
          return
        case 'card.delta':
          get().updateCard(id, (card) => ({ text: card.text + event.text, status: null }))
          return
        case 'card.done':
          get().updateCard(id, {
            text: event.text,
            suggestion: event.suggestion,
            apply: event.apply,
            done: true,
            status: null
          })
          return
        case 'looking':
          get().updateCard(id, { status: 'Looking at the window…' })
          if (snap?.window.frame) glow(snap.window.frame, 2500)
          return
        case 'status':
          get().updateCard(id, { status: event.text })
          return
        case 'recall':
          get().updateCard(id, { recall: event.hits })
          return
        case 'sources':
          get().updateCard(id, { sources: event.sources })
          return
        case 'todo':
          if (snap) propose(event.todo, snap)
          return
        case 'error':
          get().updateCard(id, { error: event.message, status: null })
          return
        default:
          return
      }
    })
    set({ serverDown: false })
  } catch (err) {
    if (control.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    get().updateCard(id, {
      error: /fetch|network|unreachable/i.test(message)
        ? "Polly's server isn't running."
        : message,
      status: null,
      done: true
    })
  } finally {
    get().updateCard(id, { done: true, status: null })
    if (acting === control) acting = null
  }
}

export function stop(): void {
  acting?.abort()
  acting = null
}

export function clearThread(): void {
  stop()
  set({ thread: [] })
}

export async function applyCard(card: Card): Promise<void> {
  if (!card.apply) return
  get().updateCard(card.id, { applied: 'applying' })
  const ok = await applyPlan(card.apply, card.app)
  get().updateCard(card.id, { applied: ok ? 'applied' : 'failed' })
  if (card.proactive) void copilotApi.feedback({ kind: 'apply', lens: card.lens, hint_kind: card.kind })
  if (ok) {
    setTimeout(() => {
      const current = get().card
      if (current?.id === card.id) set({ card: null })
    }, 1400)
  }
}

async function applyPlan(plan: ApplyPlan, app: SenseApp | null): Promise<boolean> {
  if (!bridge) return false
  const token = plan.token ?? undefined
  switch (plan.kind) {
    case 'replace_field':
      return Boolean(await bridge.write({ token, mode: 'replaceAll', text: plan.text }))
    case 'replace_selection':
      return Boolean(await bridge.write({ token, mode: 'replaceSelection', text: plan.text }))
    case 'insert':
      return Boolean(await bridge.write({ token, mode: 'insert', text: plan.text }))
    case 'cell': {
      // Excel's Go To (⌃G) takes us to the cell; elsewhere it goes in the selected cell.
      const steps =
        app?.bundleId === 'com.microsoft.Excel' && plan.cell
          ? [
              { key: 'g', modifiers: ['ctrl' as const] },
              { wait: 450 },
              { type: plan.cell },
              { key: 'return' },
              { wait: 300 },
              { paste: plan.text },
              { key: 'return' }
            ]
          : [{ paste: plan.text }, { key: 'return' }]
      return bridge.script({ pid: app?.pid, steps })
    }
    case 'fill_fields': {
      let ok = true
      for (const field of plan.fields ?? []) {
        const done = await bridge.write({ token: field.token, mode: 'replaceAll', text: field.text })
        ok = ok && Boolean(done)
      }
      return ok
    }
    default:
      return false
  }
}

export function copyCard(card: Card): void {
  void bridge?.copy(card.suggestion ?? card.text)
}

export function dismissCard(card: Card, mute = false): void {
  if (card.proactive) {
    void copilotApi.feedback({
      kind: mute ? 'mute' : 'ignore',
      lens: card.lens,
      hint_kind: card.kind
    })
  }
  if (get().card?.id === card.id) set({ card: null })
  if (!card.done) stop()
}

// ---------- to-dos ----------

function propose(todo: TodoProposal, snap: Snapshot): void {
  const { proposals } = get()
  if (proposals.some((p) => p.title === todo.title)) return
  set({ proposals: [...proposals, todo] })
  highlight(todo.evidence, snap)
  if (!isOpen()) peek(todo.title, 'todo', 6000)
}

export async function acceptTodo(todo: TodoProposal): Promise<void> {
  set({ proposals: get().proposals.filter((p) => p.id !== todo.id) })
  const res = await copilotApi.addTodo({
    title: todo.title,
    notes: todo.notes,
    due_at: todo.due_at,
    source: todo.source
  })
  void copilotApi.feedback({ kind: 'todo_accepted', title: todo.title })
  peek(res.ok ? 'Added to your to-dos' : "Couldn't add the to-do", 'info', 2000)
  bridge?.overlay({ highlights: null })
}

export function ignoreTodo(todo: TodoProposal): void {
  set({ proposals: get().proposals.filter((p) => p.id !== todo.id) })
  void copilotApi.feedback({ kind: 'todo_ignored', title: todo.title })
  bridge?.overlay({ highlights: null })
}

async function pollReminders(): Promise<void> {
  const due = await copilotApi.dueTodos()
  if (due.length === 0) return
  const known = new Set(get().reminders.map((r) => r.id))
  const fresh = due.filter((r) => !known.has(r.id))
  if (fresh.length === 0) return
  set({ reminders: [...get().reminders, ...fresh] })
  for (const reminder of fresh) void copilotApi.reminded(reminder.id)
  peek(fresh[0].title, 'reminder', 8000)
}

export async function reminderDone(id: string): Promise<void> {
  set({ reminders: get().reminders.filter((r) => r.id !== id) })
  await copilotApi.completeTodo(id)
}

export async function snoozeReminder(id: string, minutes = 10): Promise<void> {
  set({ reminders: get().reminders.filter((r) => r.id !== id) })
  await copilotApi.snooze(id, minutes)
}

// ---------- privacy ----------

/** "Hide this window": the helper stops reading it until it's shown again in Settings. */
export async function hideWindow(): Promise<void> {
  const snap = get().lastSnapshot
  if (!snap || !settings) return
  const hidden = [
    ...settings.hidden_windows.filter(
      (w) => !(w.bundle_id === snap.app.bundleId && w.title === snap.window.title)
    ),
    { bundle_id: snap.app.bundleId, app: snap.app.name, title: snap.window.title }
  ]
  const res = await copilotApi.updateSettings({ hidden_windows: hidden })
  if (!res.ok) return
  settings = res.data
  await bridge?.privacyChanged()
  shutOut(snap.app.name, 'hidden')
  set({ lastSnapshot: null })
  peek('Polly will not look at this window', 'info', 2200)
}

// ---------- the writing bubble ----------

function selectionChanged(data: Extract<SenseEvent, { event: 'selection' }>['data']): void {
  if (!bridge) return
  const selection = data.selection
  if (data.excluded || !selection || settings?.suggest.writing === false) {
    bridge.overlay({ bubble: null })
    return
  }
  if (selection.text.trim().length < 3 || !selection.bounds) {
    bridge.overlay({ bubble: null })
    return
  }
  bridge.overlay({ bubble: { selection, app: data.app, window: data.window } })
}

// ---------- the overlay ----------

function glow(rect: Rect, ms: number): void {
  bridge?.overlay({ glow: { rect, ms } })
}

/** Marks where on screen a to-do came from, using the text positions the helper read. */
function highlight(phrases: string[], snap: Snapshot): void {
  if (snap.excluded || phrases.length === 0) return
  const blocks: TextBlock[] = [...snap.ax, ...(snap.ocr ?? [])].filter((b) => b.frame)
  const rects: Rect[] = []
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  for (const phrase of phrases) {
    const wanted = norm(phrase)
    if (wanted.length < 3) continue
    for (const block of blocks) {
      const text = norm(block.text)
      const at = text.indexOf(wanted)
      if (at === -1 || !block.frame) continue
      const frame = block.frame
      // One line: mark just the phrase, by its share of the line. Several lines: the block.
      if (frame.height < 34 && text.length > 0) {
        rects.push({
          x: frame.x + (frame.width * at) / text.length,
          y: frame.y,
          width: Math.max(12, (frame.width * wanted.length) / text.length),
          height: frame.height
        })
      } else {
        rects.push(frame)
      }
      break
    }
  }
  if (rects.length) bridge?.overlay({ highlights: { rects, ms: 7000 } })
}

// ---------- small things ----------

export function peek(text: string, tone: Peek['tone'], ms: number): void {
  set({ peek: { text, tone, until: Date.now() + ms } })
  setTimeout(() => {
    const current = get().peek
    if (current && current.until <= Date.now()) set({ peek: null })
  }, ms + 20)
}

async function loadIcon(bundleId: string): Promise<void> {
  if (!bridge || !bundleId) return
  if (!icons.has(bundleId)) icons.set(bundleId, await bridge.appIcon(bundleId))
  set({ appIcon: icons.get(bundleId) ?? null })
}

export function attach(kbId: string): void {
  const attached = get().attached
  set({ attached: attached.includes(kbId) ? attached.filter((id) => id !== kbId) : [...attached, kbId] })
}

export async function refreshBases(): Promise<void> {
  set({ bases: await copilotApi.knowledgeBases() })
}

export function openRecall(hit: { url: string | null; bundle_id: string | null }): void {
  if (hit.url && /^https?:\/\//i.test(hit.url)) void bridge?.openUrl(hit.url)
  else if (hit.bundle_id) void bridge?.activate({ bundleId: hit.bundle_id })
}

export type { Turn }
