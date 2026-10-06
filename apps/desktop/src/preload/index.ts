import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CopilotBridge } from '../shared/copilot'
import type { PollyBridge } from '../shared/contracts'

/** Subscribes to a channel from the main process; returns the unsubscribe. */
function on<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const copilot: CopilotBridge = {
  state: () => ipcRenderer.invoke('copilot:state'),
  setWatching: (on) => ipcRenderer.invoke('copilot:set-watching', on),
  onState: (listener) => on('copilot:state', listener),
  onSense: (listener) => on('copilot:sense', listener),

  snapshot: (params) => ipcRenderer.invoke('copilot:snapshot', params),
  write: (params) => ipcRenderer.invoke('copilot:write', params),
  script: (params) => ipcRenderer.invoke('copilot:script', params),
  requestPermission: (kind) => ipcRenderer.invoke('copilot:request-permission', kind),
  restartHelper: () => ipcRenderer.invoke('copilot:restart-helper'),
  runningApps: () => ipcRenderer.invoke('copilot:running-apps'),
  appIcon: (bundleId) => ipcRenderer.invoke('copilot:app-icon', bundleId),
  activate: (target) => ipcRenderer.invoke('copilot:activate', target),
  privacyChanged: () => ipcRenderer.invoke('copilot:privacy-changed'),

  openMain: (section) => ipcRenderer.invoke('copilot:open-main', section),
  openUrl: (url) => ipcRenderer.invoke('copilot:open-url', url),
  copy: (text) => ipcRenderer.invoke('copilot:copy', text),

  setIslandRect: (rect) => ipcRenderer.send('notch:island', rect),
  onHover: (listener) => on('notch:hover', listener),
  setIslandFocusable: (focus) => ipcRenderer.send('notch:focusable', focus),

  overlay: (payload) => ipcRenderer.send('overlay:show', payload),
  onOverlay: (listener) => on('overlay:payload', listener),
  setOverlayRect: (rect) => ipcRenderer.send('overlay:rect', rect),
  overlayIdle: () => ipcRenderer.send('overlay:idle'),
  onOverlayHover: (listener) => on('overlay:hover', listener)
}

const bridge: PollyBridge = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  serverUrl: () => ipcRenderer.invoke('app:server-url'),
  pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
  revealPath: (path) => ipcRenderer.invoke('app:reveal-path', path),
  setBackgroundColor: (hex) => ipcRenderer.invoke('app:set-background', hex),
  copilot
}

contextBridge.exposeInMainWorld('polly', bridge)
