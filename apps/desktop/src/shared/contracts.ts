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
  /** Native folder picker; resolves to null when the user cancels. */
  pickFolder: () => Promise<string | null>
  /** Show a path in Finder / Explorer. */
  revealPath: (path: string) => Promise<void>
  /** Keep the window chrome in step with the renderer's theme. */
  setBackgroundColor: (hex: string) => Promise<void>
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
  /** Tools the agent can call: search, git, sandbox, computer… */
  tools: string[]
  /** Connected apps the agent may use (Composio toolkit slugs). */
  integrations: string[]
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
  github: { provider: string; configured: boolean }
  composio: { provider: string; configured: boolean }
}

// ---------- models ----------

export interface ModelOption {
  id: string
  label: string
  vendor: string
  context_window: number
  reasoning: boolean
  vision: boolean
  /** Output speed on the shared endpoint. */
  tokens_per_second: number | null
  /** USD per million tokens. */
  input_price: number | null
  output_price: number | null
  is_default: boolean
  is_default_fast: boolean
}

export interface ModelList {
  models: ModelOption[]
  default: string
  default_fast: string
}

// ---------- coder: projects and sessions ----------

/**
 * supervised: ask before every edit and command · trusted: edits go through,
 * commands and deletes ask · autonomous: never asks · plan: read-only
 */
export type PermissionMode = 'supervised' | 'trusted' | 'autonomous' | 'plan'

export interface Rule {
  tool: string
  pattern: string
}

export interface ProjectSettings {
  default_model: string
  default_mode: PermissionMode
  command_allowlist: string[]
  command_denylist: string[]
  /** Research each Coder change against docs and advisories when a run ends. */
  auto_research: boolean
}

export interface Project {
  id: string
  name: string
  path: string
  created_at: number
  settings: ProjectSettings
  /** The checked-out git branch; null outside a git repository. */
  branch: string | null
  /** The machine the folder lives on. */
  host: string
}

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size?: number | null
  children?: TreeNode[] | null
}

export interface FileContent {
  path: string
  content: string
  truncated: boolean
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'error'

export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface Session {
  id: string
  /** The Coder's project; null for research and review sessions. */
  project_id: string | null
  /** coder · researcher · deep-research · reviewer · change-research */
  agent_id: string
  /** Set on change research started from a Coder session. */
  parent_session_id: string | null
  title: string
  model: string
  mode: PermissionMode
  created_at: number
  updated_at: number
  status: SessionStatus
  usage: UsageTotals
  context_tokens: number
  last_error: string | null
}

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ToolCallRef {
  id: string
  name: string
  args: Record<string, unknown>
}

export type WireMessage =
  | { role: 'user'; id: string; text: string }
  | {
      role: 'assistant'
      id: string
      text: string
      reasoning: string
      tool_calls: ToolCallRef[]
      usage: UsageTotals | null
    }
  | {
      role: 'tool'
      id: string
      call_id: string
      name: string
      status: 'ok' | 'error' | 'blocked' | 'rejected'
      output: string
      truncated: boolean
    }

export interface ApprovalRequest {
  index: number
  name: string
  args: Record<string, unknown>
  description: string
  allowed_decisions: ('approve' | 'edit' | 'reject')[]
  kind: 'edit' | 'delete' | 'command' | 'other'
  preview: { path?: string | null; command?: string | null }
}

export interface ApprovalRequired {
  interrupt_id: string | null
  requests: ApprovalRequest[]
}

export interface Transcript {
  session: Session
  messages: WireMessage[]
  todos: Todo[]
  pending_approval: ApprovalRequired | null
  run_id: string | null
}

export type Decision =
  | { type: 'approve' }
  | { type: 'edit'; edited_action: { name: string; args: Record<string, unknown> } }
  | { type: 'reject'; message?: string }

export interface RememberRule {
  index: number
  pattern: string
}

export type ChangeKind = 'created' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  kind: ChangeKind
  additions: number
  deletions: number
  /** agent: made with the file tools · shell: seen in git after a command */
  source: 'agent' | 'shell'
}

export interface FileDiff {
  path: string
  kind: ChangeKind
  before: string
  after: string
  binary: boolean
}

export interface ProjectMemory {
  polly_md: string | null
  memory_md: string | null
}

// ---------- research and reviews ----------

/** A page an agent read or found, numbered for citations: `[n]`. */
export interface Source {
  id: number
  url: string
  title: string
  favicon: string | null
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface ChangeFinding {
  severity: Severity
  title: string
  detail: string
  file: string | null
  sources: number[]
}

/** What change research hands in after a Coder run. */
export interface ChangeReport {
  summary: string
  verdict: 'looks_good' | 'needs_attention' | 'risky'
  findings: ChangeFinding[]
  pr_title: string
  pr_description: string
  sources: Source[]
  created_at: number
}

export interface ScoreCategory {
  key: string
  label: string
  weight: number
  /** After Polly's caps. */
  score: number
  /** What the model gave before any cap. */
  model_score: number
  rationale: string
  evidence: string[]
}

export interface ReviewFinding {
  severity: Severity
  title: string
  detail: string
  file: string | null
  line: number | null
  suggestion: string | null
  sources: number[]
}

export interface CIState {
  state: 'passing' | 'failing' | 'pending' | 'none'
  failing?: string[]
  pending?: string[]
  passing?: number
}

export interface PRFacts {
  url: string
  slug: string
  title: string
  author: string | null
  state?: string
  draft?: boolean
  base?: string
  head?: string
  additions: number
  deletions: number
  changed_files: number
  has_description?: boolean
  linked_issue?: boolean
  tests_touched?: string[]
  manifests_touched?: string[]
  ci: CIState
  partial: boolean
}

export interface Scorecard {
  total: number
  raw_total: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  verdict: 'approve' | 'comment' | 'request_changes'
  adjustments: string[]
  categories: ScoreCategory[]
  summary: string
  strengths: string[]
  findings: ReviewFinding[]
  sources: Source[]
  pr: Partial<PRFacts>
  created_at: number
}

export interface Artifacts {
  sources: Source[]
  report: ChangeReport | null
  scorecard: Scorecard | null
  pr: PRFacts | null
}

// ---------- integrations ----------

export interface GitHubStatus {
  connected: boolean
  login: string | null
}

/**
 * oauth: sign in on the provider's site · api_key: paste a key on Composio's
 * page · none: nothing to connect · custom: needs your own OAuth app.
 */
export type IntegrationAuth = 'oauth' | 'api_key' | 'none' | 'custom'

/** ready: works without an account. */
export type IntegrationState = 'connected' | 'expired' | 'available' | 'ready'

export interface Integration {
  /** The Composio toolkit slug. */
  slug: string
  name: string
  category: string
  description: string
  auth: IntegrationAuth
  state: IntegrationState
  connected_at: string | null
  /** How many tools the app gives an agent; null when not known. */
  tools: number | null
  /** Ids of the agents allowed to use it. */
  agents: string[]
}

export interface IntegrationsStatus {
  composio: { provider: string; configured: boolean }
  tavily: { provider: string; configured: boolean }
  github: GitHubStatus
  categories: { id: string; label: string }[]
  items: Integration[]
}

// ---------- coder: the event stream ----------

interface EventBase {
  seq: number
  run_id: string
}

/** An artboard as the Designer's tools report it (`design/document.py`). */
export interface DesignArtboard {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  background: string
  html: string
}

export type CoderEvent =
  | (EventBase & { type: 'tool.streaming'; agent: string; name: string; artboard_id?: string })
  | (EventBase & {
      type: 'design.artboard'
      action: 'create' | 'write' | 'edit'
      artboard: DesignArtboard
      focus: string[]
      rev: number
    })
  | (EventBase & { type: 'design.removed'; artboard_id: string; rev: number })
  | (EventBase & { type: 'design.fonts'; fonts: string[]; rev: number })
  | (EventBase & { type: 'design.screenshot'; request_id: string; artboard_id: string })
  | (EventBase & {
      type: 'run.started'
      session_id: string
      agent_id?: string
      model: string
      mode: PermissionMode
    })
  | (EventBase & {
      type: 'message.delta'
      message_id: string
      agent: string
      text?: string
      reasoning?: string
    })
  | (EventBase & {
      type: 'message.completed'
      message_id: string
      agent: string
      text: string
      reasoning: string
      tool_calls: ToolCallRef[]
      usage: UsageTotals | null
    })
  | (EventBase & {
      type: 'tool.call'
      agent: string
      message_id: string
      call_id: string
      name: string
      args: Record<string, unknown>
    })
  | (EventBase & {
      type: 'tool.result'
      agent: string
      call_id: string
      name: string
      status: 'ok' | 'error' | 'blocked' | 'rejected'
      output: string
      truncated: boolean
      duration_ms: number | null
    })
  | (EventBase & {
      type: 'subagent.started'
      task_id: string
      name: string
      description: string
      call_id: string | null
    })
  | (EventBase & { type: 'subagent.completed'; task_id: string; name: string; summary: string })
  | (EventBase & { type: 'approval.required' } & ApprovalRequired)
  | (EventBase & { type: 'todos.updated'; todos: Todo[] })
  | (EventBase & { type: 'file.changed' } & FileChange)
  | (EventBase &
      UsageTotals & {
        type: 'usage'
        run_total: UsageTotals
        session_total: UsageTotals
        context_tokens: number
        context_window: number | null
        replayed?: boolean
      })
  | (EventBase & { type: 'compaction'; node: string })
  | (EventBase & { type: 'sources.added'; sources: Source[] })
  | (EventBase & { type: 'report'; report: ChangeReport })
  | (EventBase & { type: 'scorecard'; scorecard: Scorecard })
  | (EventBase & {
      type: 'research.started'
      session_id: string
      parent_session_id: string
      title: string
    })
  | (EventBase & {
      type: 'run.finished'
      status: 'completed' | 'awaiting_approval' | 'cancelled' | 'error'
      error: string | null
      duration_ms: number
    })
