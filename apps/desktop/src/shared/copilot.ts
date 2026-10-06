/**
 * Shapes shared by the Electron main process and the copilot's two windows:
 * the island in the notch and the overlay that draws on top of other apps.
 */
import type {
  NotchGeometry,
  Permissions,
  Rect,
  RunningApp,
  ScriptStep,
  SenseApp,
  SenseEvent,
  SenseMethods,
  SenseWindow,
  Selection,
  Snapshot
} from './sense'

export type HelperState = 'starting' | 'ready' | 'missing' | 'error'

export interface CopilotState {
  /** Reading the screen; toggled with ⌃⌥P. */
  watching: boolean
  helper: { state: HelperState; message: string | null; path: string | null }
  permissions: Permissions
  geometry: NotchGeometry
  /** The shortcut that turns watching on and off, for display ("⌃⌥P"). */
  shortcut: string
}

/** What the overlay draws over other apps. Rects are global screen points. */
export interface OverlayPayload {
  /** Marks phrases on screen (the source of a to-do); cleared after `ms`. */
  highlights?: { rects: Rect[]; ms: number } | null
  /** A soft border around the window Polly is looking at. */
  glow?: { rect: Rect; ms: number } | null
  /** The writing bubble next to a selection. */
  bubble?: { selection: Selection; app: SenseApp; window: SenseWindow } | null
}

export interface CopilotBridge {
  state: () => Promise<CopilotState>
  setWatching: (on: boolean) => Promise<CopilotState>
  onState: (listener: (state: CopilotState) => void) => () => void
  onSense: (listener: (event: SenseEvent) => void) => () => void

  snapshot: (params: SenseMethods['snapshot'][0]) => Promise<Snapshot | null>
  write: (params: SenseMethods['write'][0]) => Promise<SenseMethods['write'][1] | null>
  script: (params: { pid?: number; steps: ScriptStep[] }) => Promise<boolean>
  requestPermission: (kind: 'accessibility' | 'screenRecording') => Promise<void>
  restartHelper: () => Promise<void>
  runningApps: () => Promise<RunningApp[]>
  appIcon: (bundleId: string) => Promise<string | null>
  activate: (target: { pid?: number; bundleId?: string }) => Promise<void>
  /** Re-reads exclusions from the server and hands them to the helper. */
  privacyChanged: () => Promise<void>

  /** Shows the main window, on a section ("settings", "knowledge"…). */
  openMain: (section?: string) => Promise<void>
  openUrl: (url: string) => Promise<void>
  copy: (text: string) => Promise<void>

  /** The island reports the part of its window that takes the mouse. */
  setIslandRect: (rect: Rect | null) => void
  onHover: (listener: (inside: boolean) => void) => () => void
  /** Lets the island take keyboard focus (for its text field) or give it back. */
  setIslandFocusable: (focus: boolean) => void

  /** Draw on the overlay; partial: keys left out stay as they are. */
  overlay: (payload: OverlayPayload) => void
  onOverlay: (listener: (payload: OverlayPayload & { origin: Rect }) => void) => () => void
  /** The overlay reports where its bubble is, or null when nothing takes the mouse. */
  setOverlayRect: (rect: Rect | null) => void
  /** The overlay has nothing left to draw and can hide. */
  overlayIdle: () => void
  onOverlayHover: (listener: (inside: boolean) => void) => () => void
}
