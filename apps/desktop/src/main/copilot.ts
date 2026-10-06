import { app, clipboard, globalShortcut, ipcMain, screen, shell } from 'electron'
import type { CopilotState, OverlayPayload } from '../shared/copilot'
import type { NotchGeometry, PrivacyRules, Rect, SenseEvent, SenseMethods } from '../shared/sense'
import { FloatingPanel } from './floating'
import { Sense } from './sense'

/**
 * The copilot in the notch, on the Electron side: the island window, the
 * overlay that draws over other apps, the ⌃⌥P switch, and the bridge from
 * both windows to Polly Sense. What to do with what the helper reads lives
 * in the island's page (`renderer/src/notch`) and on the server.
 */

const SHORTCUT = 'Control+Alt+P'
const SHORTCUT_LABEL = '⌃⌥P'
// The island's window: room for the widest island and its shadow.
const NOTCH_WIDTH = 760
const NOTCH_HEIGHT = 660
// How often the helper checks whether the window in front changed visibly.
const VISUAL_INTERVAL = 4000

export class Copilot {
  private readonly sense = new Sense()
  private notch: FloatingPanel | null = null
  private overlay: FloatingPanel | null = null
  private overlayOrigin: Rect | null = null
  private watching = false
  private permissions = { accessibility: false, screenRecording: false }
  private geometry: NotchGeometry = fallbackGeometry()

  constructor(
    private readonly serverUrl: string,
    private readonly openMain: (section?: string) => void
  ) {}

  start(): void {
    this.registerIpc()
    this.sense.on('status', () => void this.helperChanged())
    this.sense.on('event', (event: SenseEvent) => this.senseEvent(event))
    this.sense.start()

    this.notch = new FloatingPanel(
      'notch',
      this.notchBounds(),
      { name: 'main-menu', relative: 3 },
      (inside) => this.notch?.send('notch:hover', inside)
    )
    this.notch.win.once('ready-to-show', () => this.notch?.show())

    screen.on('display-metrics-changed', () => this.placeNotch())
    screen.on('display-added', () => this.placeNotch())
    screen.on('display-removed', () => this.placeNotch())

    if (!globalShortcut.register(SHORTCUT, () => void this.setWatching(!this.watching))) {
      console.warn(`[copilot] ${SHORTCUT} is taken by another app`)
    }
  }

  async stop(): Promise<void> {
    globalShortcut.unregister(SHORTCUT)
    await this.sense.shutdown()
    this.notch?.destroy()
    this.overlay?.destroy()
  }

  // ---------- state ----------

  private state(): CopilotState {
    const status = this.sense.status
    return {
      watching: this.watching,
      helper: {
        state: status.state,
        message: status.state === 'error' ? status.message : null,
        path: status.state === 'missing' ? status.path : null
      },
      permissions: this.permissions,
      geometry: this.geometry,
      shortcut: SHORTCUT_LABEL
    }
  }

  private broadcast(): void {
    const state = this.state()
    this.notch?.send('copilot:state', state)
    this.overlay?.send('copilot:state', state)
  }

  private async setWatching(on: boolean): Promise<CopilotState> {
    this.watching = on
    if (this.sense.ready) {
      try {
        await this.sense.call('watch', {
          enabled: on,
          visualIntervalMs: on ? VISUAL_INTERVAL : 0
        })
      } catch (err) {
        console.warn('[copilot] watch failed', err)
      }
    }
    if (!on) this.overlay?.send('overlay:payload', { bubble: null, glow: null, highlights: null })
    this.broadcast()
    return this.state()
  }

  private async helperChanged(): Promise<void> {
    if (this.sense.ready) {
      try {
        this.permissions = await this.sense.call('permissions', {})
        this.geometry = await this.sense.call('geometry', {})
        this.placeNotch()
        await this.syncPrivacy()
        if (this.watching) {
          await this.sense.call('watch', { enabled: true, visualIntervalMs: VISUAL_INTERVAL })
        }
      } catch (err) {
        console.warn('[copilot] helper setup failed', err)
      }
    }
    this.broadcast()
  }

  private senseEvent(event: SenseEvent): void {
    if (event.event === 'permissions') {
      this.permissions = event.data
      this.broadcast()
      return
    }
    if (event.event === 'geometry') {
      this.geometry = event.data
      this.placeNotch()
      this.broadcast()
      return
    }
    // Nothing reaches the pages while the user has the copilot off.
    if (!this.watching) return
    this.notch?.send('copilot:sense', event)
  }

  /** Exclusions live on the server (Settings → Copilot); the helper enforces them. */
  private async syncPrivacy(): Promise<void> {
    if (!this.sense.ready) return
    const rules: PrivacyRules = {
      apps: [],
      domains: [],
      windows: [],
      selfPids: app.getAppMetrics().map((m) => m.pid)
    }
    try {
      const res = await fetch(`${this.serverUrl}/copilot/settings`, {
        signal: AbortSignal.timeout(4000)
      })
      if (res.ok) {
        const prefs = (await res.json()) as {
          exclusions: { apps: { bundle_id: string }[]; domains: string[] }
          hidden_windows: { bundle_id: string; title: string }[]
        }
        rules.apps = prefs.exclusions.apps.map((a) => a.bundle_id)
        rules.domains = prefs.exclusions.domains
        rules.windows = prefs.hidden_windows.map((w) => ({ bundleId: w.bundle_id, title: w.title }))
      }
    } catch {
      // The server is not up yet: Polly's own windows are still excluded, and
      // the island calls privacyChanged once it reaches the server.
    }
    await this.sense.call('setPrivacy', rules)
  }

  // ---------- windows ----------

  private notchBounds(): Rect {
    const { screen: area, notch } = this.geometry
    const centre = notch ? notch.x + notch.width / 2 : area.x + area.width / 2
    return { x: centre - NOTCH_WIDTH / 2, y: area.y, width: NOTCH_WIDTH, height: NOTCH_HEIGHT }
  }

  private placeNotch(): void {
    if (!this.sense.ready) this.geometry = fallbackGeometry()
    this.notch?.place(this.notchBounds())
    this.broadcast()
  }

  private overlayPanel(): FloatingPanel {
    if (!this.overlay) {
      const display = screen.getPrimaryDisplay().bounds
      this.overlay = new FloatingPanel(
        'overlay',
        display,
        { name: 'floating', relative: 1 },
        (inside) => this.overlay?.send('overlay:hover', inside)
      )
      this.overlayOrigin = display
    }
    return this.overlay
  }

  /** Puts the overlay over the display that holds what it has to draw, then draws. */
  private showOverlay(payload: OverlayPayload): void {
    const panel = this.overlayPanel()
    const anchor =
      payload.bubble?.selection.bounds ??
      payload.glow?.rect ??
      payload.highlights?.rects[0] ??
      null
    if (anchor) {
      const display = screen.getDisplayNearestPoint({
        x: Math.round(anchor.x + anchor.width / 2),
        y: Math.round(anchor.y + anchor.height / 2)
      }).bounds
      panel.place(display)
      this.overlayOrigin = display
    }
    const send = (): void => {
      panel.show()
      panel.send('overlay:payload', { ...payload, origin: this.overlayOrigin })
    }
    if (panel.win.webContents.isLoading()) panel.win.webContents.once('did-finish-load', send)
    else send()
  }

  // ---------- IPC ----------

  private registerIpc(): void {
    ipcMain.handle('copilot:state', () => this.state())
    ipcMain.handle('copilot:set-watching', (_e, on: boolean) => this.setWatching(Boolean(on)))

    ipcMain.handle('copilot:snapshot', async (_e, params: SenseMethods['snapshot'][0]) => {
      // Never read the screen while the copilot is off.
      if (!this.watching || !this.sense.ready) return null
      try {
        // The first OCR on a Mac waits for Vision to load its models (~25 s); later ones take
        // well under a second.
        return await this.sense.call('snapshot', params, 45_000)
      } catch (err) {
        console.warn('[copilot] snapshot failed', err)
        return null
      }
    })
    ipcMain.handle('copilot:write', async (_e, params: SenseMethods['write'][0]) => {
      try {
        return await this.sense.call('write', params)
      } catch (err) {
        console.warn('[copilot] write failed', err)
        return null
      }
    })
    ipcMain.handle('copilot:script', async (_e, params: SenseMethods['script'][0]) => {
      try {
        await this.sense.call('script', params, 20_000)
        return true
      } catch (err) {
        console.warn('[copilot] script failed', err)
        return false
      }
    })
    ipcMain.handle('copilot:request-permission', async (_e, kind) => {
      if (kind !== 'accessibility' && kind !== 'screenRecording') return
      await this.sense.call('requestPermission', { kind }).catch(() => undefined)
    })
    ipcMain.handle('copilot:restart-helper', () => this.sense.restart())
    ipcMain.handle('copilot:running-apps', async () =>
      this.sense.ready ? this.sense.call('runningApps', {}).catch(() => []) : []
    )
    ipcMain.handle('copilot:app-icon', async (_e, bundleId: string) => {
      if (!this.sense.ready || typeof bundleId !== 'string') return null
      const res = await this.sense.call('appIcon', { bundleId, size: 64 }).catch(() => null)
      return res?.png ?? null
    })
    ipcMain.handle('copilot:activate', async (_e, target: { pid?: number; bundleId?: string }) => {
      if (this.sense.ready) await this.sense.call('activate', target).catch(() => undefined)
    })
    ipcMain.handle('copilot:privacy-changed', () => this.syncPrivacy().catch(() => undefined))

    ipcMain.handle('copilot:open-main', (_e, section?: string) => this.openMain(section))
    ipcMain.handle('copilot:open-url', (_e, url: string) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
    })
    ipcMain.handle('copilot:copy', (_e, text: string) => {
      if (typeof text === 'string') clipboard.writeText(text)
    })

    ipcMain.on('notch:island', (_e, rect: Rect | null) => this.notch?.setHit(rect))
    ipcMain.on('notch:focusable', (_e, focus: boolean) => {
      if (!focus && this.notch?.win.isFocused()) this.notch.win.blur()
    })
    ipcMain.on('overlay:show', (_e, payload: OverlayPayload) => this.showOverlay(payload))
    ipcMain.on('overlay:rect', (_e, rect: Rect | null) => this.overlay?.setHit(rect))
    ipcMain.on('overlay:idle', () => this.overlay?.hide())
  }
}

/** Until the helper reports the real notch: a best guess from Electron's displays. */
function fallbackGeometry(): NotchGeometry {
  const displays = screen.getAllDisplays()
  const display = displays.find((d) => d.internal) ?? screen.getPrimaryDisplay()
  const menuBar = Math.max(0, display.workArea.y - display.bounds.y) || 24
  // Notched MacBooks have a taller menu bar (about 37 points) than other Macs (24).
  const hasNotch = Boolean(display.internal) && menuBar >= 32
  const width = 200
  return {
    screen: display.bounds,
    notch: hasNotch
      ? {
          x: display.bounds.x + display.bounds.width / 2 - width / 2,
          y: display.bounds.y,
          width,
          height: menuBar
        }
      : null,
    menuBarHeight: menuBar,
    hasNotch,
    scale: display.scaleFactor
  }
}
