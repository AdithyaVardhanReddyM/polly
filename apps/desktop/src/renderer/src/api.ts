import type {
  AgentSummary,
  Decision,
  FileChange,
  FileContent,
  FileDiff,
  ModelList,
  Project,
  ProjectMemory,
  ProjectSettings,
  RememberRule,
  Result,
  Rule,
  ServerHealth,
  Session,
  Transcript,
  TreeNode
} from '../../shared/contracts'

const DEFAULT_SERVER = 'http://127.0.0.1:8787'

let base: Promise<string> | null = null

/** Electron tells us where the server is; the browser build uses the default. */
export function serverUrl(): Promise<string> {
  base ??= window.polly ? window.polly.serverUrl() : Promise.resolve(DEFAULT_SERVER)
  return base
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeout = 8000
): Promise<Result<T>> {
  const url = `${await serverUrl()}${path}`
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    })
    if (!res.ok) {
      let detail = `${path} returned HTTP ${res.status}`
      try {
        const payload = (await res.json()) as { detail?: unknown }
        if (typeof payload.detail === 'string') detail = payload.detail
      } catch {
        /* no JSON body */
      }
      return { ok: false, error: detail }
    }
    if (res.status === 204) return { ok: true, data: undefined as T }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `agent server unreachable (${reason})` }
  }
}

const get = <T>(path: string): Promise<Result<T>> => request<T>('GET', path)
const post = <T>(path: string, body?: unknown): Promise<Result<T>> => request<T>('POST', path, body)
const patch = <T>(path: string, body: unknown): Promise<Result<T>> => request<T>('PATCH', path, body)
const del = (path: string): Promise<Result<void>> => request<void>('DELETE', path)

const q = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return ''
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

export const api = {
  health: () => get<ServerHealth>('/health'),
  agents: async (): Promise<Result<AgentSummary[]>> => {
    const res = await get<{ agents: AgentSummary[] }>('/agents')
    return res.ok ? { ok: true, data: res.data.agents } : res
  },
  models: () => get<ModelList>('/models'),

  projects: {
    list: async (): Promise<Result<Project[]>> => {
      const res = await get<{ projects: Project[] }>('/projects')
      return res.ok ? { ok: true, data: res.data.projects } : res
    },
    add: (path: string) => post<Project>('/projects', { path }),
    update: (id: string, settings: Partial<ProjectSettings>) =>
      patch<Project>(`/projects/${id}`, settings),
    remove: (id: string) => del(`/projects/${id}`),
    tree: (id: string, path = '', depth = 1) =>
      get<TreeNode[]>(`/projects/${id}/tree${q({ path, depth })}`),
    file: (id: string, path: string) => get<FileContent>(`/projects/${id}/file${q({ path })}`),
    rules: async (id: string): Promise<Result<Rule[]>> => {
      const res = await get<{ rules: Rule[] }>(`/projects/${id}/rules`)
      return res.ok ? { ok: true, data: res.data.rules } : res
    },
    removeRule: async (id: string, index: number): Promise<Result<Rule[]>> => {
      const res = await request<{ rules: Rule[] }>('DELETE', `/projects/${id}/rules/${index}`)
      return res.ok ? { ok: true, data: res.data.rules } : res
    },
    memory: (id: string) => get<ProjectMemory>(`/projects/${id}/memory`),
    init: (id: string) => post<Session>(`/projects/${id}/init`),
    sessions: async (id: string): Promise<Result<Session[]>> => {
      const res = await get<{ sessions: Session[] }>(`/projects/${id}/sessions`)
      return res.ok ? { ok: true, data: res.data.sessions } : res
    }
  },

  sessions: {
    create: (body: { project_id: string; model?: string; mode?: string; title?: string }) =>
      post<Session>('/sessions', body),
    get: (id: string) => get<Session>(`/sessions/${id}`),
    update: (id: string, body: { model?: string; mode?: string; title?: string }) =>
      patch<Session>(`/sessions/${id}`, body),
    remove: (id: string) => del(`/sessions/${id}`),
    transcript: (id: string) => get<Transcript>(`/sessions/${id}/messages`),
    cancel: (id: string) => post<{ cancelled: boolean }>(`/sessions/${id}/cancel`),
    changes: (id: string) => get<FileChange[]>(`/sessions/${id}/changes`),
    diff: (id: string, path: string) => get<FileDiff>(`/sessions/${id}/changes/diff${q({ path })}`),
    accept: (id: string, paths: string[] = []) =>
      post<FileChange[]>(`/sessions/${id}/changes/accept`, { paths }),
    revert: (id: string, paths: string[] = []) =>
      post<FileChange[]>(`/sessions/${id}/changes/revert`, { paths })
  }
}

/** Bodies for the streaming endpoints (see `sse.ts`). */
export const streams = {
  message: (sessionId: string, content: string) => ({
    path: `/sessions/${sessionId}/messages`,
    body: { content }
  }),
  decisions: (sessionId: string, decisions: Decision[], remember: RememberRule[] = []) => ({
    path: `/sessions/${sessionId}/decisions`,
    body: { decisions, remember }
  }),
  events: (sessionId: string, after: number) => ({
    path: `/sessions/${sessionId}/events${q({ after })}`,
    body: undefined
  })
}
