import { contextBridge, ipcRenderer } from 'electron'
import type { PollyBridge } from '../shared/contracts'

const bridge: PollyBridge = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  serverUrl: () => ipcRenderer.invoke('app:server-url')
}

contextBridge.exposeInMainWorld('polly', bridge)
