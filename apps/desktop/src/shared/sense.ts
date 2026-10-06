/**
 * The wire protocol between the Electron main process and Polly Sense, the
 * native helper that reads the screen (`apps/desktop/native/PollySense`).
 *
 * Transport: newline-delimited JSON over a Unix domain socket. Electron
 * listens; the helper connects to the path it was launched with
 * (`--socket <path>`) and exits when the socket closes.
 *
 *   request   {"id": 7, "method": "snapshot", "params": {...}}
 *   response  {"id": 7, "result": ...}  or  {"id": 7, "error": {"message": "..."}}
 *   event     {"event": "typing", "data": {...}}
 *
 * Coordinates are global screen points with the origin at the top-left of the
 * primary display: the space the Accessibility API, CGWindowList and
 * Electron's `screen` module all use.
 *
 * Keep `apps/desktop/native/PollySense/Sources/PollySense/Protocol.swift` in
 * step with this file.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SenseApp {
  name: string
  bundleId: string
  pid: number
}

export interface SenseWindow {
  /** CGWindowID; null when the window could not be matched. */
  id: number | null
  title: string
  frame: Rect | null
}

/** The element that has keyboard focus. */
export interface FocusedElement {
  role: string
  subrole: string | null
  /** Its title, description or placeholder, whichever it has. */
  label: string | null
  /** Its text; null for secure fields and for elements without text. */
  value: string | null
  selectedText: string | null
  selectedRange: { location: number; length: number } | null
  editable: boolean
  secure: boolean
  frame: Rect | null
  /** Hands this element to `write` later, even after focus moved on. */
  token: string
}

export interface Selection {
  text: string
  /** Where the selected text is on screen, for anchoring the writing bubble. */
  bounds: Rect | null
  editable: boolean
  token: string
}

export interface TextBlock {
  text: string
  frame: Rect | null
  /** ax: read through the Accessibility API · ocr: Apple Vision text recognition */
  source: 'ax' | 'ocr'
  role?: string
  confidence?: number
}

/** An input in the focused window: what "Fill form" and "Clear form" write to. */
export interface FormField {
  /** Its title, description or placeholder, else the text just before it. */
  label: string
  /** AXTextField, AXTextArea, AXComboBox, AXCheckBox, AXRadioButton, AXPopUpButton… */
  role: string
  /** Its text; "1"/"0" for check boxes and radio buttons; null for secure fields. */
  value: string | null
  frame: Rect | null
  /** Hands this field to `write`. */
  token: string
}

export interface Screenshot {
  /** Base64 JPEG of the focused window, at most 1280 points wide. */
  jpeg: string
  width: number
  height: number
}

interface SnapshotBase {
  /** Epoch milliseconds. */
  at: number
  app: SenseApp
  window: SenseWindow
  /** The page URL when the app is a browser. */
  url: string | null
}

export interface ContextSnapshot extends SnapshotBase {
  excluded: false
  /** The file the window shows (AXDocument), when it has one. */
  document: string | null
  focused: FocusedElement | null
  selection: Selection | null
  /** Visible text from the accessibility tree, in reading order. */
  ax: TextBlock[]
  axChars: number
  /** Editable inputs in the window, top to bottom (at most 60); secure fields are left out. */
  fields: FormField[]
  /** Text recognised in a screenshot of the window; null when OCR did not run. */
  ocr: TextBlock[] | null
  ocrMs: number | null
  screenshot: Screenshot | null
  /** 64-bit difference hash of the window image, hex; null without a capture. */
  hash: string | null
}

/** Privacy settings hid this app, site or window: nothing was read. */
export interface ExcludedSnapshot extends SnapshotBase {
  excluded: true
  reason: 'app' | 'domain' | 'window' | 'self'
}

export type Snapshot = ContextSnapshot | ExcludedSnapshot

export interface NotchGeometry {
  /** The display the island lives on: the built-in one with a notch, else the main display. */
  screen: Rect
  /** The hardware notch; null on displays without one. */
  notch: Rect | null
  menuBarHeight: number
  hasNotch: boolean
  scale: number
}

export interface Permissions {
  accessibility: boolean
  screenRecording: boolean
}

export interface PrivacyRules {
  /** Bundle ids never read. */
  apps: string[]
  /** Sites never read, matched against the browser URL's host and its parents. */
  domains: string[]
  /** Windows the user hid with one click. */
  windows: { bundleId: string; title: string }[]
  /** Polly's own processes: never read. */
  selfPids: number[]
}

export interface RunningApp {
  name: string
  bundleId: string
  pid: number
  /** Base64 PNG, 64 px. */
  icon: string | null
}

export type ScriptStep =
  | { key: string; modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[] }
  | { paste: string }
  | { type: string }
  | { wait: number }

/** Requests: method → [params, result]. */
export interface SenseMethods {
  hello: [Record<string, never>, { version: string; pid: number }]
  permissions: [Record<string, never>, Permissions]
  /** Shows the system prompt, or opens the right pane of System Settings. */
  requestPermission: [{ kind: 'accessibility' | 'screenRecording' }, { opened: boolean }]
  geometry: [Record<string, never>, NotchGeometry]
  setPrivacy: [PrivacyRules, { ok: true }]
  /** Starts or stops the events below. `visualIntervalMs` 0 turns visual checks off. */
  watch: [{ enabled: boolean; visualIntervalMs?: number }, { ok: true }]
  snapshot: [
    { ocr: 'auto' | 'always' | 'never'; screenshot: boolean; maxAxNodes?: number },
    Snapshot
  ]
  /**
   * Puts text into an app: through the Accessibility API when the element
   * allows it, else by pasting (the clipboard is restored afterwards).
   * replaceSelection: the selected text · replaceAll: the whole field · insert: at the caret
   */
  write: [
    { token?: string; mode: 'replaceSelection' | 'replaceAll' | 'insert'; text: string },
    { method: 'ax' | 'paste' }
  ]
  /** Brings the app forward, then sends keys and pastes in order. */
  script: [{ pid?: number; steps: ScriptStep[] }, { ok: true }]
  appIcon: [{ bundleId: string; size?: number }, { png: string | null }]
  runningApps: [Record<string, never>, RunningApp[]]
  activate: [{ pid?: number; bundleId?: string }, { ok: boolean }]
  quit: [Record<string, never>, { ok: true }]
}

export type SenseMethod = keyof SenseMethods

interface EventBase {
  app: SenseApp
  window: SenseWindow
  /** Privacy settings hide this app, site or window: its content was not read. */
  excluded: boolean
}

/** Events: name → data. Only sent while watching. */
export interface SenseEvents {
  /** Another app came to the front. */
  app: EventBase
  /** Focus moved to another window or element. */
  focus: EventBase & { focused: FocusedElement | null }
  /** The user typed in an editable element and paused (about 1.2 s). */
  typing: EventBase & { focused: FocusedElement }
  /** The selection changed; null when it was cleared. */
  selection: EventBase & { selection: Selection | null }
  /** Content in the focused window changed outside the focused element (a new message…). */
  content: EventBase
  /** The window's image changed noticeably since the last check. */
  visual: EventBase & { hash: string; distance: number }
  /** Sent whenever either permission changes (and while watching, re-checked every 2 s). */
  permissions: Permissions
  /** Displays were added, removed or rearranged. */
  geometry: NotchGeometry
}

export type SenseEvent = {
  [K in keyof SenseEvents]: { event: K; data: SenseEvents[K] }
}[keyof SenseEvents]
