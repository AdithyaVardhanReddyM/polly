import {
  Bot,
  Eye,
  FilePen,
  FilePlus,
  FileSearch,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  ListChecks,
  Search,
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
