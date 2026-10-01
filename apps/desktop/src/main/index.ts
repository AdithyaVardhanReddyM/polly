import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { AppInfo, Result } from '../shared/contracts'

const serverUrl = process.env.POLLY_SERVER_URL ?? 'http://127.0.0.1:8787'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
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
