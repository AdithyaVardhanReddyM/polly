import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppInfo, Result } from '../shared/contracts'
import { Copilot } from './copilot'

const serverUrl = process.env.POLLY_SERVER_URL ?? 'http://127.0.0.1:8787'

let mainWindow: BrowserWindow | null = null
let copilot: Copilot | null = null

/** Brings the main window forward, on a section ("settings", "knowledge"…) if given. */
function openMain(section?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const win = mainWindow
  if (!win) return
  if (section && /^[\w/-]+$/.test(section)) {
    const go = (): void => void win.webContents.executeJavaScript(`location.hash = '#${section}'`)
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go)
    else go()
  }
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Polly',
    titleBarStyle: 'hiddenInset',
    // Pinned: the folded sidebar and the headers beside it make room for these.
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#fafafb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Anything that wants a real browser gets one; nothing navigates the shell away.
  // Only web links: pages from search results must not open local files or apps.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    void mainWindow.loadURL(devServer)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(
    'app:info',
    (): Result<AppInfo> => ({
      ok: true,
      data: {
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform
      }
    })
  )
  ipcMain.handle('app:server-url', () => serverUrl)

  ipcMain.handle('app:pick-folder', async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Open a project folder',
      buttonLabel: 'Open',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('app:reveal-path', (_event, path: string) => {
    if (typeof path === 'string' && path.length > 0) shell.showItemInFolder(path)
  })

  ipcMain.handle('app:set-background', (_event, hex: string) => {
    if (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) {
      mainWindow?.setBackgroundColor(hex)
    }
  })
}

void app.whenReady().then(() => {
  app.setName('Polly')
  registerIpc()
  createWindow()

  // The copilot in the notch (macOS only: it needs the notch and the native helper).
  if (process.platform === 'darwin') {
    copilot = new Copilot(serverUrl, openMain)
    copilot.start()
  }

  app.on('activate', () => {
    // The notch and overlay windows always exist; only the main window counts here.
    if (!mainWindow) createWindow()
    else mainWindow.show()
  })
})

app.on('will-quit', (event) => {
  if (!copilot) return
  // Let the helper quit first; it would anyway, once our socket closes.
  event.preventDefault()
  const stopping = copilot
  copilot = null
  void stopping.stop().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
