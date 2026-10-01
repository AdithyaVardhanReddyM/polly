/**
 * Types shared by the Electron main process, the preload bridge and the
 * renderer. Shapes that come from the agent server mirror
 * `server/polly_server/api/schemas.py` — keep the two in step.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
}

/** What the preload script exposes as `window.polly`. Absent in the browser. */
export interface PollyBridge {
  appInfo: () => Promise<Result<AppInfo>>
  serverUrl: () => Promise<string>
}

// ---------- agent server ----------

export type Division = 'coding' | 'research' | 'everyday' | 'custom'

export type AgentStatus = 'ready' | 'building' | 'planned'

/** deep: Deep Agents (long-running) · agent: LangChain agent · graph: LangGraph flow */
export type AgentRuntime = 'deep' | 'agent' | 'graph'

export interface AgentSummary {
  id: string
  name: string
  division: Division
  tagline: string
  description: string
  status: AgentStatus
  runtime: AgentRuntime
  /** Tools the agent can call: integrations, sandbox, computer, search… */
  tools: string[]
  /** Specialists the agent can hand work to. */
  subagents: string[]
  /** Whether the agent gets its own virtual computer. */
  computer: boolean
  /** DiceBear voxel-bot options; always includes a `seed`. */
  avatar: Record<string, string>
}

export interface ServerHealth {
  service: string
  version: string
  model: { provider: string; id: string; configured: boolean }
  sandbox: { provider: string; configured: boolean }
  search: { provider: string; configured: boolean }
}
