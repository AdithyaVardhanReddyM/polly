import type {
  AgentConfig,
  AgentDraft,
  AgentFields,
  AgentSummary,
  Artifacts,
  AskAnswer,
  Decision,
  Effort,
  FileChange,
  FileContent,
  FileDiff,
  Group,
  GroupFields,
  IntegrationsStatus,
  KnowledgeBase,
  KnowledgeDetail,
  KnowledgeFile,
  KnowledgeHit,
  Memory,
  ModelList,
  Project,
  ProjectMemory,
  ProjectSettings,
  RememberRule,
  Result,
  Routine,
  RoutineFields,
  Rule,
  ServerHealth,
  Session,
  TodoFields,
  TodoItem,
  TodoPatch,
  Transcript,
  TreeNode,
  Variable,
  VariableFields
} from '../../shared/contracts'
import type { DesignDoc } from './design/model'

const DEFAULT_SERVER = 'http://127.0.0.1:8787'

let base: Promise<string> | null = null

/** Electron tells us where the server is; the browser build uses the default. */
export function serverUrl(): Promise<string> {
  base ??= window.polly ? window.polly.serverUrl() : Promise.resolve(DEFAULT_SERVER)
  return base
}

export async function request<T>(
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
/** For calls that wait on another service (fetching a PR, starting a sign-in). */
const postSlow = <T>(path: string, body?: unknown): Promise<Result<T>> =>
  request<T>('POST', path, body, 60_000)
const patch = <T>(path: string, body: unknown): Promise<Result<T>> => request<T>('PATCH', path, body)
const del = (path: string): Promise<Result<void>> => request<void>('DELETE', path)

/** POST a multipart form. No content-type header: the browser writes it, with the boundary. */
async function multipart<T>(path: string, form: FormData, timeout = 120_000): Promise<Result<T>> {
  const url = `${await serverUrl()}${path}`
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeout) })
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
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `agent server unreachable (${reason})` }
  }
}

const q = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return ''
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

const unwrapMemories = (res: Result<{ memories: Memory[] }>): Result<Memory[]> =>
  res.ok ? { ok: true, data: res.data.memories } : res

/** Where the app can load a file an agent saved in its sandbox (`/outputs/…`). */
export function outputUrl(server: string, sessionId: string, path: string): string {
  return `${server}/sessions/${sessionId}/outputs${q({ path })}`
}

export const api = {
  health: () => get<ServerHealth>('/health'),
  agents: async (): Promise<Result<AgentSummary[]>> => {
    const res = await get<{ agents: AgentSummary[] }>('/agents')
    return res.ok ? { ok: true, data: res.data.agents } : res
  },
  models: () => get<ModelList>('/models'),

  /** Who an agent may hand work to, and whether everyone may call on everyone. */
  team: {
    set: (agentId: string, teammates: string[]) =>
      request<AgentSummary>('PUT', `/agents/${encodeURIComponent(agentId)}/teammates`, {
        teammates
      }),
    collaboration: () => get<{ open: boolean }>('/collaboration'),
    setCollaboration: (open: boolean) =>
      request<{ open: boolean }>('PUT', '/collaboration', { open })
  },

  groups: {
    list: async (): Promise<Result<Group[]>> => {
      const res = await get<{ groups: Group[] }>('/groups')
      return res.ok ? { ok: true, data: res.data.groups } : res
    },
    create: (body: GroupFields) => post<Group>('/groups', body),
    update: (id: string, body: Partial<GroupFields>) => patch<Group>(`/groups/${id}`, body),
    remove: (id: string) => del(`/groups/${id}`)
  },

  /** The agents people make themselves. */
  custom: {
    create: (body: AgentFields) => post<AgentSummary>('/agents', body),
    config: (id: string) => get<AgentConfig>(`/agents/${encodeURIComponent(id)}/config`),
    update: (id: string, body: Partial<AgentFields>) =>
      patch<AgentSummary>(`/agents/${encodeURIComponent(id)}`, body),
    remove: (id: string) => del(`/agents/${encodeURIComponent(id)}`),
    /** Has a model write the name, tagline and instructions. */
    draft: (description: string) => postSlow<AgentDraft>('/agents/draft', { description })
  },

  memory: {
    list: async (): Promise<Result<Memory[]>> => unwrapMemories(await get('/memory')),
    add: async (text: string): Promise<Result<Memory[]>> =>
      unwrapMemories(await post('/memory', { text })),
    remove: async (id: string): Promise<Result<Memory[]>> =>
      unwrapMemories(await request('DELETE', `/memory/${encodeURIComponent(id)}`)),
    clear: async (): Promise<Result<Memory[]>> => unwrapMemories(await request('DELETE', '/memory'))
  },

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
    create: (body: {
      project_id?: string | null
      agent_id?: string
      group_id?: string
      members?: string[]
      model?: string
      reasoning_effort?: Effort
      mode?: string
      title?: string
    }) => post<Session>('/sessions', body),
    /** Top-level sessions with one agent (Coder sessions are listed per project). */
    list: async (agentId: string): Promise<Result<Session[]>> => {
      const res = await get<{ sessions: Session[] }>(`/sessions${q({ agent_id: agentId })}`)
      return res.ok ? { ok: true, data: res.data.sessions } : res
    },
    /** The conversations of one group. */
    listGroup: async (groupId: string): Promise<Result<Session[]>> => {
      const res = await get<{ sessions: Session[] }>(`/sessions${q({ group_id: groupId })}`)
      return res.ok ? { ok: true, data: res.data.sessions } : res
    },
    get: (id: string) => get<Session>(`/sessions/${id}`),
    update: (
      id: string,
      body: {
        model?: string
        reasoning_effort?: Effort
        mode?: string
        title?: string
        members?: string[]
      }
    ) => patch<Session>(`/sessions/${id}`, body),
    remove: (id: string) => del(`/sessions/${id}`),
    transcript: (id: string) => get<Transcript>(`/sessions/${id}/messages`),
    cancel: (id: string) => post<{ cancelled: boolean }>(`/sessions/${id}/cancel`),
    changes: (id: string) => get<FileChange[]>(`/sessions/${id}/changes`),
    diff: (id: string, path: string) => get<FileDiff>(`/sessions/${id}/changes/diff${q({ path })}`),
    accept: (id: string, paths: string[] = []) =>
      post<FileChange[]>(`/sessions/${id}/changes/accept`, { paths }),
    revert: (id: string, paths: string[] = []) =>
      post<FileChange[]>(`/sessions/${id}/changes/revert`, { paths }),
    artifacts: (id: string) => get<Artifacts>(`/sessions/${id}/artifacts`),
    /** Change research started from a Coder session, newest first. */
    research: async (id: string): Promise<Result<Session[]>> => {
      const res = await get<{ sessions: Session[] }>(`/sessions/${id}/research`)
      return res.ok ? { ok: true, data: res.data.sessions } : res
    },
    researchNow: (id: string) => post<Session>(`/sessions/${id}/research`),
    commentPreview: (id: string) =>
      get<{ markdown: string }>(`/sessions/${id}/scorecard/preview`),
    postComment: (id: string) => postSlow<{ url: string }>(`/sessions/${id}/scorecard/post`)
  },

  design: {
    get: (id: string) => get<DesignDoc>(`/sessions/${id}/design`),
    put: (id: string, doc: DesignDoc) => request<DesignDoc>('PUT', `/sessions/${id}/design`, doc),
    screenshot: (id: string, requestId: string, dataUrl: string) =>
      request<{ accepted: boolean }>(
        'POST',
        `/sessions/${id}/design/screenshots/${requestId}`,
        { data_url: dataUrl },
        30_000
      ),
    /** Store an image the user added; the body is the file itself. */
    upload: async (id: string, file: Blob, name: string): Promise<Result<{ name: string; url: string }>> => {
      const url = `${await serverUrl()}/sessions/${id}/design/assets${q({ name })}`
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file
        })
        const payload = (await res.json()) as { detail?: string; name: string; url: string }
        if (!res.ok) return { ok: false, error: payload.detail ?? `HTTP ${res.status}` }
        return { ok: true, data: payload }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  },

  reviews: {
    create: (prUrl: string, model?: string) =>
      postSlow<Session>('/reviews', { pr_url: prUrl, model })
  },

  integrations: {
    /** `fresh` skips the server's short cache, for polling during a sign-in. */
    status: (fresh = false) =>
      request<IntegrationsStatus>('GET', `/integrations${fresh ? '?fresh=true' : ''}`, undefined, 30_000),
    /** Returns the link to open in the browser. */
    connect: (slug: string) =>
      postSlow<{ url: string }>(`/integrations/${encodeURIComponent(slug)}/connect`),
    disconnect: (slug: string) =>
      request<IntegrationsStatus>(
        'DELETE',
        `/integrations/${encodeURIComponent(slug)}`,
        undefined,
        60_000
      ),
    /** Replace the set of connected apps an agent may use. */
    setForAgent: (agentId: string, integrations: string[]) =>
      request<AgentSummary>('PUT', `/agents/${encodeURIComponent(agentId)}/integrations`, {
        integrations
      })
  },

  /** To-dos and reminders: typed in, spotted on screen by the copilot, or added by agents. */
  todos: {
    list: async (status: 'open' | 'done' | 'all' = 'open'): Promise<Result<TodoItem[]>> => {
      const res = await get<{ todos: TodoItem[] }>(`/todos${q({ status })}`)
      return res.ok ? { ok: true, data: res.data.todos } : res
    },
    create: (body: TodoFields) => post<TodoItem>('/todos', body),
    update: (id: string, body: TodoPatch) => patch<TodoItem>(`/todos/${encodeURIComponent(id)}`, body),
    remove: (id: string) => del(`/todos/${encodeURIComponent(id)}`),
    /** Open to-dos whose reminder is due and has not been shown yet. */
    due: async (): Promise<Result<TodoItem[]>> => {
      const res = await get<{ todos: TodoItem[] }>('/todos/due')
      return res.ok ? { ok: true, data: res.data.todos } : res
    },
    /** The reminder was shown; it fires once. */
    reminded: (id: string) => post<TodoItem>(`/todos/${encodeURIComponent(id)}/reminded`),
    snooze: (id: string, minutes: number) =>
      post<TodoItem>(`/todos/${encodeURIComponent(id)}/snooze`, { minutes })
  },

  /** Files Polly answers from. Chat streams through `stream()` (see `sse.ts`). */
  knowledge: {
    list: async (): Promise<Result<KnowledgeBase[]>> => {
      const res = await get<{ bases: KnowledgeBase[] }>('/knowledge')
      return res.ok ? { ok: true, data: res.data.bases } : res
    },
    create: (body: { name: string; description?: string }) => post<KnowledgeBase>('/knowledge', body),
    get: (id: string) => get<KnowledgeDetail>(`/knowledge/${encodeURIComponent(id)}`),
    update: (id: string, body: { name?: string; description?: string }) =>
      patch<KnowledgeBase>(`/knowledge/${encodeURIComponent(id)}`, body),
    remove: (id: string) => del(`/knowledge/${encodeURIComponent(id)}`),
    upload: async (id: string, files: File[]): Promise<Result<KnowledgeFile[]>> => {
      const form = new FormData()
      for (const file of files) form.append('files', file, file.name)
      const res = await multipart<{ files: KnowledgeFile[] }>(
        `/knowledge/${encodeURIComponent(id)}/files`,
        form
      )
      return res.ok ? { ok: true, data: res.data.files } : res
    },
    removeFile: (id: string, fileId: string) =>
      del(`/knowledge/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`),
    search: async (id: string, query: string, k?: number): Promise<Result<KnowledgeHit[]>> => {
      const res = await post<{ hits: KnowledgeHit[] }>(`/knowledge/${encodeURIComponent(id)}/search`, {
        query,
        k
      })
      return res.ok ? { ok: true, data: res.data.hits } : res
    }
  },

  /** Settings and secrets for agents; secret values are only ever sent, never read. */
  variables: {
    list: async (): Promise<Result<Variable[]>> => {
      const res = await get<{ variables: Variable[] }>('/variables')
      return res.ok ? { ok: true, data: res.data.variables } : res
    },
    put: (name: string, body: VariableFields) =>
      request<Variable>('PUT', `/variables/${encodeURIComponent(name)}`, body),
    remove: async (name: string): Promise<Result<Variable[]>> => {
      const res = await request<{ variables: Variable[] }>(
        'DELETE',
        `/variables/${encodeURIComponent(name)}`
      )
      return res.ok ? { ok: true, data: res.data.variables } : res
    }
  },

  /** Tasks an agent or a group runs by itself, on a schedule or on a GitHub event. */
  routines: {
    list: async (): Promise<Result<Routine[]>> => {
      const res = await get<{ routines: Routine[] }>('/routines')
      return res.ok ? { ok: true, data: res.data.routines } : res
    },
    create: (body: RoutineFields) => post<Routine>('/routines', body),
    update: (id: string, body: Partial<Pick<RoutineFields, 'name' | 'prompt' | 'trigger' | 'enabled'>>) =>
      patch<Routine>(`/routines/${encodeURIComponent(id)}`, body),
    remove: (id: string) => del(`/routines/${encodeURIComponent(id)}`),
    run: (id: string) => postSlow<Routine>(`/routines/${encodeURIComponent(id)}/run`)
  }
}

/** Bodies for the streaming endpoints (see `sse.ts`). */
export const streams = {
  message: (sessionId: string, content: string, mentions: string[] = []) => ({
    path: `/sessions/${sessionId}/messages`,
    body: { content, mentions }
  }),
  decisions: (sessionId: string, decisions: Decision[], remember: RememberRule[] = []) => ({
    path: `/sessions/${sessionId}/decisions`,
    body: { decisions, remember }
  }),
  answer: (sessionId: string, interruptId: string | null, value: AskAnswer) => ({
    path: `/sessions/${sessionId}/answer`,
    body: { interrupt_id: interruptId, ...value }
  }),
  events: (sessionId: string, after: number) => ({
    path: `/sessions/${sessionId}/events${q({ after })}`,
    body: undefined
  })
}
