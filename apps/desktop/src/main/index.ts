import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppInfo, Result } from '../shared/contracts'

const serverUrl = process.env.POLLY_SERVER_URL ?? 'http://127.0.0.1:8787'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Polly',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafafb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Anything that wants a real browser gets one; nothing navigates the shell away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
