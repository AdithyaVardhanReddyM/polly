import type { AgentSummary, Result, ServerHealth } from '../../shared/contracts'

const DEFAULT_SERVER = 'http://127.0.0.1:8787'

let base: Promise<string> | null = null

/** Electron tells us where the server is; the browser build uses the default. */
function serverUrl(): Promise<string> {
  base ??= window.polly ? window.polly.serverUrl() : Promise.resolve(DEFAULT_SERVER)
  return base
}

async function get<T>(path: string): Promise<Result<T>> {
  const url = `${await serverUrl()}${path}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return { ok: false, error: `${path} returned HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `agent server unreachable (${reason})` }
  }
}

export const api = {
  health: () => get<ServerHealth>('/health'),
  agents: async (): Promise<Result<AgentSummary[]>> => {
    const res = await get<{ agents: AgentSummary[] }>('/agents')
    return res.ok ? { ok: true, data: res.data.agents } : res
  }
}
