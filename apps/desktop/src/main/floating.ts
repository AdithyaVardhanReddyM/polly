import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import type { Rect } from '../shared/sense'

/**
 * A transparent window that floats over every app and lets clicks through,
 * except over the part its page says is interactive (the island, a bubble).
 *
 * macOS can't hit-test a transparent window per pixel, so the window ignores
 * the mouse and we poll the cursor (30 times a second, only while something
 * is interactive), switching the mouse back on while it is over that part.
 */
export class FloatingPanel {
  readonly win: BrowserWindow
  private hit: Rect | null = null
  private inside = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    page: 'notch' | 'overlay',
    bounds: Rect,
    level: { name: 'main-menu' | 'floating'; relative: number },
    private readonly onHover: (inside: boolean) => void
  ) {
    this.win = new BrowserWindow({
      ...bounds,
      // A non-activating panel: clicking it leaves the user's app in front, so
      // their selection and caret stay where they were.
      type: 'panel',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      show: false,
      // Frameless windows may then sit over the menu bar, where the notch is.
      enableLargerThanScreen: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.win.setAlwaysOnTop(true, level.name, level.relative)
    this.win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    this.win.setIgnoreMouseEvents(true, { forward: true })
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer) void this.win.loadURL(`${devServer}/${page}.html`)
    else void this.win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }

  place(bounds: Rect): void {
    const rounded = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    }
    const now = this.win.getBounds()
    if (
      now.x !== rounded.x ||
      now.y !== rounded.y ||
      now.width !== rounded.width ||
      now.height !== rounded.height
    ) {
      this.win.setBounds(rounded)
    }
  }

  show(): void {
    if (!this.win.isVisible()) this.win.showInactive()
  }

  hide(): void {
    this.setHit(null)
    if (this.win.isVisible()) this.win.hide()
  }

  /** The interactive part, in the window's own coordinates; null: all click-through. */
  setHit(rect: Rect | null): void {
    this.hit = rect
    if (rect && !this.timer) {
      this.timer = setInterval(() => this.poll(), 33)
    } else if (!rect && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.setInside(false)
    }
  }

  send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  destroy(): void {
    this.setHit(null)
    if (!this.win.isDestroyed()) this.win.destroy()
  }

  private poll(): void {
    if (!this.hit || this.win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const origin = this.win.getBounds()
    const slack = 2
    const x = cursor.x - origin.x
    const y = cursor.y - origin.y
    const inside =
      x >= this.hit.x - slack &&
      x <= this.hit.x + this.hit.width + slack &&
      y >= this.hit.y - slack &&
      y <= this.hit.y + this.hit.height + slack
    this.setInside(inside)
  }

  private setInside(inside: boolean): void {
    if (inside === this.inside) return
    this.inside = inside
    if (!this.win.isDestroyed()) this.win.setIgnoreMouseEvents(!inside, { forward: true })
    this.onHover(inside)
  }
}
