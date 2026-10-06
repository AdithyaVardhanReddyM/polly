import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { SenseEvent, SenseMethod, SenseMethods } from '../shared/sense'

/**
 * Talks to Polly Sense, the native helper that reads the screen
 * (`native/PollySense`, protocol in `shared/sense.ts`).
 *
 * The helper is its own signed app, launched through LaunchServices so macOS
 * asks for Accessibility and Screen Recording in its name and remembers them
 * across rebuilds. It connects back to a Unix socket we listen on, and quits
 * when that socket closes, so it never outlives Polly.
 */

export type SenseStatus =
  | { state: 'starting' }
  | { state: 'ready'; version: string }
  | { state: 'missing'; path: string }
  | { state: 'error'; message: string }

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const CONNECT_TIMEOUT = 12_000

export function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'Polly Sense.app')
    : join(app.getAppPath(), 'native', 'build', 'Polly Sense.app')
}

export class Sense extends EventEmitter {
  status: SenseStatus = { state: 'starting' }
  private server: net.Server | null = null
  private socket: net.Socket | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private stopping = false
  private restarts: number[] = []
  private readonly socketPath = join(tmpdir(), `polly-sense-${process.pid}.sock`)

  start(): void {
    this.stopping = false
    const path = helperPath()
    if (!existsSync(path)) {
      this.setStatus({ state: 'missing', path })
      return
    }
    this.setStatus({ state: 'starting' })
    this.listen()
    this.launch(path)
  }

  /** Quits the helper and starts a fresh one (after a permission was granted, say). */
  async restart(): Promise<void> {
    await this.shutdown()
    this.start()
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.socket) {
      try {
        await this.call('quit', {}, 1500)
      } catch {
        /* it is going away either way */
      }
    }
    this.socket?.destroy()
    this.socket = null
    this.server?.close()
    this.server = null
    rmSync(this.socketPath, { force: true })
  }

  get ready(): boolean {
    return this.status.state === 'ready'
  }

  call<M extends SenseMethod>(
    method: M,
    params: SenseMethods[M][0],
    timeout = 10_000
  ): Promise<SenseMethods[M][1]> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('Polly Sense is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Polly Sense did not answer ${method}`))
      }, timeout)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      socket.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  private setStatus(status: SenseStatus): void {
    this.status = status
    this.emit('status', status)
  }

  private listen(): void {
    rmSync(this.socketPath, { force: true })
    this.server = net.createServer((socket) => {
      // One helper at a time: a newer connection replaces an older one.
      this.socket?.destroy()
      this.socket = socket
      this.buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => this.read(chunk))
      socket.on('close', () => this.closed(socket))
      socket.on('error', () => socket.destroy())
      void this.call('hello', {}).then(
        (hello) => this.setStatus({ state: 'ready', version: hello.version }),
        (err: Error) => this.setStatus({ state: 'error', message: err.message })
      )
    })
    this.server.listen(this.socketPath)
  }

  private launch(path: string): void {
    execFile('open', ['-n', '-g', path, '--args', '--socket', this.socketPath], (err) => {
      if (err) this.setStatus({ state: 'error', message: `could not open Polly Sense: ${err.message}` })
    })
    setTimeout(() => {
      if (!this.socket && !this.stopping && this.status.state === 'starting') {
        this.setStatus({ state: 'error', message: 'Polly Sense did not start' })
      }
    }, CONNECT_TIMEOUT)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let cut = this.buffer.indexOf('\n')
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut + 1)
      if (line) this.dispatch(line)
      cut = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message: string }; event?: string }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
      return
    }
    if (message.event) this.emit('event', message as SenseEvent)
  }

  private closed(socket: net.Socket): void {
    if (socket !== this.socket) return
    this.socket = null
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('Polly Sense quit'))
    }
    this.pending.clear()
    if (this.stopping) return
    // It crashed: start it again, but give up after three crashes in a minute.
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < 60_000)
    if (this.restarts.length >= 3) {
      this.setStatus({ state: 'error', message: 'Polly Sense keeps quitting' })
      return
    }
    this.restarts.push(now)
    this.setStatus({ state: 'starting' })
    this.launch(helperPath())
  }
}
