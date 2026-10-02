import { contextBridge, ipcRenderer } from 'electron'
import type { PollyBridge } from '../shared/contracts'

const bridge: PollyBridge = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  serverUrl: () => ipcRenderer.invoke('app:server-url'),
  pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
  revealPath: (path) => ipcRenderer.invoke('app:reveal-path', path),
  setBackgroundColor: (hex) => ipcRenderer.invoke('app:set-background', hex)
}

contextBridge.exposeInMainWorld('polly', bridge)
