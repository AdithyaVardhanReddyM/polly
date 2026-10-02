import {
  BookOpen,
  Bot,
  ClipboardCheck,
  Eye,
  FileCode,
  FilePen,
  FilePlus,
  FileSearch,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitPullRequest,
  Gauge,
  Globe,
  ListChecks,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Wrench
} from 'lucide-react'

export interface ToolMeta {
  icon: React.JSX.Element
  /** Verb shown on the card, e.g. "Read", "Edit". */
  verb: string
  /** The one thing that identifies this call: a path, a command, a pattern. */
  target: string
}

const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

const prSlug = (url: unknown): string => {
  const m = s(url).match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  return m ? `${m[1]}/${m[2]}#${m[3]}` : s(url)
}

export function toolMeta(name: string, args: Record<string, unknown>): ToolMeta {
  const path = s(args.file_path ?? args.path).replace(/^\//, '') || '.'
  switch (name) {
    case 'read_file':
      return { icon: <Eye />, verb: 'Read', target: path }
    case 'write_file':
      return { icon: <FilePlus />, verb: 'Write', target: path }
    case 'edit_file':
      return { icon: <FilePen />, verb: 'Edit', target: path }
    case 'delete':
      return { icon: <Trash2 />, verb: 'Delete', target: path }
    case 'ls':
      return { icon: <Folder />, verb: 'List', target: path }
    case 'glob':
      return { icon: <FileSearch />, verb: 'Find', target: s(args.pattern) }
    case 'grep':
      return {
        icon: <Search />,
        verb: 'Search',
        target: `${s(args.pattern)}${args.path ? `  in ${path}` : ''}`
      }
    case 'execute':
      return { icon: <SquareTerminal />, verb: 'Run', target: s(args.command) }
    case 'write_todos':
      return { icon: <ListChecks />, verb: 'Plan', target: 'Updated the plan' }
    case 'web_search':
      return { icon: <Globe />, verb: 'Search the web', target: s(args.query) }
    case 'research_search':
      return { icon: <Globe />, verb: 'Search', target: s(args.query) }
    case 'web_extract': {
      const urls = Array.isArray(args.urls) ? args.urls.map(s) : []
      const hosts = urls.map((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, '')
        } catch {
          return u
        }
      })
      return { icon: <BookOpen />, verb: 'Read', target: hosts.join(', ') }
    }
    case 'github_pr_overview':
      return { icon: <GitPullRequest />, verb: 'Open PR', target: prSlug(args.pr_url) }
    case 'github_pr_files':
      return {
        icon: <GitCompare />,
        verb: 'Read diff',
        target: `${prSlug(args.pr_url)}${args.page && args.page !== 1 ? `  page ${s(args.page)}` : ''}`
      }
    case 'github_file':
      return { icon: <FileCode />, verb: 'Read', target: s(args.path) }
    case 'github_pr_checks':
      return { icon: <ShieldCheck />, verb: 'Check CI', target: prSlug(args.pr_url) }
    case 'submit_scorecard':
      return { icon: <Gauge />, verb: 'Score', target: 'Handed in the scorecard' }
    case 'submit_change_report':
      return { icon: <ClipboardCheck />, verb: 'Report', target: s(args.pr_title) }
    case 'git_status':
      return { icon: <GitCompare />, verb: 'Git status', target: '' }
    case 'git_diff':
      return { icon: <GitCompare />, verb: 'Git diff', target: s(args.path) }
    case 'git_branch':
      return { icon: <GitBranch />, verb: 'Branch', target: s(args.name) }
    case 'git_commit':
      return { icon: <GitCommitHorizontal />, verb: 'Commit', target: s(args.message).split('\n')[0] }
    case 'task':
      return { icon: <Bot />, verb: 'Delegate', target: s(args.subagent_type) }
    default:
      return { icon: <Wrench />, verb: name, target: '' }
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

export function relativeTime(epochSeconds: number): string {
  const diff = Date.now() / 1000 - epochSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 7 * 86_400) return `${Math.floor(diff / 86_400)}d ago`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}
