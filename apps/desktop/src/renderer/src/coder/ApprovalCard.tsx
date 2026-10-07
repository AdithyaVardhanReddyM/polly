import { FilePen, Globe, ShieldAlert, SquareTerminal, Trash2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovalRequest,
  ApprovalRequired,
  Decision,
  RememberRule
} from '../../../shared/contracts'
import { api } from '../api'
import { useCoder } from '../store/coder'
import { DiffView } from './DiffView'

/** The "always allow" scopes we offer for one request. */
function scopes(req: ApprovalRequest): { label: string; pattern: string }[] {
  if (req.kind === 'command') {
    const cmd = String(req.args.command ?? req.args.message ?? '').trim()
    if (req.name !== 'execute') return [{ label: `every ${req.name.replace('git_', 'git ')}`, pattern: '' }]
    const words = cmd.split(/\s+/)
    const out = [{ label: 'this exact command', pattern: cmd }]
    if (words.length > 1) out.push({ label: `commands starting "${words.slice(0, 2).join(' ')}"`, pattern: words.slice(0, 2).join(' ') })
    if (words.length > 2 || words.length === 1)
      out.push({ label: `any "${words[0]}" command`, pattern: words[0] })
    return out
  }
  const path = String(req.args.file_path ?? '').replace(/^\//, '')
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const out = [{ label: 'this file', pattern: path }]
  if (dir) out.push({ label: `everything in ${dir}/`, pattern: `${dir}/**` })
  out.push({ label: 'any file', pattern: '**' })
  return out
}

const ICON = {
  edit: <FilePen />,
  delete: <Trash2 />,
  command: <SquareTerminal />,
  network: <Globe />,
  other: <ShieldAlert />
}

const TITLE = {
  edit: 'Edit',
  delete: 'Delete',
  command: 'Run command',
  network: 'Network access',
  other: 'Use a tool'
}

type Decide = (decisions: Decision[], remember?: RememberRule[]) => Promise<void>

/**
 * A paused action waiting for the user. The Coder's store answers by default;
 * other chats pass their own `onDecide`.
 */
export function ApprovalCard({
  approval,
  onDecide
}: {
  approval: ApprovalRequired
  onDecide?: Decide
}): React.JSX.Element {
  const coderDecide = useCoder((s) => s.decide)
  const decide = onDecide ?? coderDecide
  const requests = approval.requests
  // An approved network rule stays in the sandbox's policy: nothing to remember.
  const network = requests.every((r) => r.kind === 'network')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const approveRef = useRef<HTMLButtonElement>(null)

  // Take focus from the composer so Y / N work straight away.
  useEffect(() => {
    approveRef.current?.focus({ preventScroll: true })
  }, [approval])

  const submit = (type: 'approve' | 'reject', always = false): void => {
    if (busy) return
    setBusy(true)
    const decisions: Decision[] = requests.map(() =>
      type === 'approve' ? { type: 'approve' } : { type: 'reject', message: reason || undefined }
    )
    const remember: RememberRule[] = always
      ? requests.map((r) => ({ index: r.index, pattern: scope[r.index] ?? scopes(r)[0].pattern }))
      : []
    void decide(decisions, remember)
  }

  // Keyboard: Enter / Y approves, Escape / N starts a rejection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === 'y' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        submit('approve')
      } else if (e.key === 'n' || e.key === 'Escape') {
        e.preventDefault()
        setRejecting(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const options = requests.length === 1 && !network ? scopes(requests[0]) : []
  const only = requests[0]

  return (
    <div className="approval" role="group" aria-label="Approval needed">
      {requests.map((r) => (
        <RequestView key={r.index} request={r} />
      ))}
      {rejecting ? (
        <div className="approval-foot">
          <input
            className="approval-reason"
            autoFocus
            placeholder={
              network
                ? 'Tell the agent why, or what to do instead (optional)'
                : 'Tell the Coder what to do instead (optional)'
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit('reject')
              if (e.key === 'Escape') setRejecting(false)
            }}
          />
          <button className="btn" onClick={() => setRejecting(false)} disabled={busy}>
            Back
          </button>
          <button className="btn btn-danger" onClick={() => submit('reject')} disabled={busy}>
            Reject
          </button>
        </div>
      ) : (
        <div className="approval-foot">
          <button
            ref={approveRef}
            className="btn btn-primary"
            onClick={() => submit('approve')}
            disabled={busy}
          >
            {requests.length > 1 ? 'Approve all' : 'Approve'}
            <kbd>Y</kbd>
          </button>
          {!network && (
            <button className="btn" onClick={() => submit('approve', true)} disabled={busy}>
              Always allow
            </button>
          )}
          {options.length > 1 && (
            <select
              className="approval-scope"
              aria-label="What “Always allow” covers"
              title="What “Always allow” covers"
              value={scope[only.index] ?? options[0].pattern}
              onChange={(e) => setScope({ ...scope, [only.index]: e.target.value })}
            >
              {options.map((o) => (
                <option key={o.label} value={o.pattern}>
                  for {o.label}
                </option>
              ))}
            </select>
          )}
          <span className="approval-spacer" />
          <button className="btn btn-ghost" onClick={() => setRejecting(true)} disabled={busy}>
            Reject
            <kbd>N</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

function RequestView({ request }: { request: ApprovalRequest }): React.JSX.Element {
  const projectId = useCoder((s) => s.projectId)
  const path = String(request.args.file_path ?? '')
  const [current, setCurrent] = useState<string | null>(null)

  // For edits, show the whole-file effect when we can read the file.
  useEffect(() => {
    if (request.name !== 'edit_file' || !projectId || !path) return
    let live = true
    void api.projects.file(projectId, path).then((res) => {
      if (live && res.ok && !res.data.truncated) setCurrent(res.data.content)
    })
    return () => {
      live = false
    }
  }, [request.name, projectId, path])

  const diff = useMemo(() => {
    const a = request.args
    if (request.name === 'write_file') return { before: '', after: String(a.content ?? '') }
    if (request.name === 'edit_file') {
      const oldS = String(a.old_string ?? '')
      const newS = String(a.new_string ?? '')
      if (current !== null && current.includes(oldS)) {
        const after = a.replace_all ? current.split(oldS).join(newS) : current.replace(oldS, newS)
        return { before: current, after }
      }
      return { before: oldS, after: newS }
    }
    return null
  }, [request, current])

  const shown = request.kind === 'network' ? hosts(request.args) : path.replace(/^\//, '')
  return (
    <div className="approval-item">
      <div className="approval-head">
        <span className={`approval-kind is-${request.kind}`}>{ICON[request.kind]}</span>
        <b>{TITLE[request.kind]}</b>
        {shown && <code title={shown}>{shown}</code>}
        <span className="approval-state">Waiting for approval</span>
      </div>
      {request.kind === 'network' && <NetworkView args={request.args} />}
      {request.kind === 'command' && (
        <pre className="approval-command">
          <span>$ </span>
          {String(request.args.command ?? request.args.message ?? request.description)}
        </pre>
      )}
      {diff && (
        <div className="approval-diff">
          <DiffView
            before={diff.before}
            after={diff.after}
            context={3}
            maxLines={300}
            path={shown || undefined}
          />
        </div>
      )}
      {request.kind === 'delete' && (
        <p className="approval-note">The file will be removed from the project.</p>
      )}
    </div>
  )
}

/** A drafted OpenShell rule: `args` as the server's `openshell_sandbox._request` writes them. */
interface Endpoint {
  host: string
  port: number
  access?: string
  rules?: string[]
}

function endpointsOf(args: Record<string, unknown>): Endpoint[] {
  return Array.isArray(args.endpoints) ? (args.endpoints as Endpoint[]) : []
}

function hosts(args: Record<string, unknown>): string {
  return endpointsOf(args)
    .map((e) => `${e.host}:${e.port}`)
    .join(', ')
}

function NetworkView({ args }: { args: Record<string, unknown> }): React.JSX.Element {
  const text = (key: string): string => (typeof args[key] === 'string' ? String(args[key]) : '')
  const endpoints = endpointsOf(args)
  const access = [...new Set(endpoints.map((e) => e.access).filter(Boolean))].join(', ')
  const rules = endpoints.flatMap((e) => e.rules ?? []).join(', ')
  const facts: [string, string][] = (
    [
      ['Program', text('binary')],
      ['Access', access],
      ['Requests', rules],
      ['Why', text('rationale')],
      ['Prover', text('validation')],
      ['Security', text('security_notes')]
    ] as [string, string][]
  ).filter(([, value]) => value)
  return (
    <>
      {text('command') && (
        <pre className="approval-command">
          <span>$ </span>
          {text('command')}
        </pre>
      )}
      {facts.length > 0 && (
        <dl className="approval-facts">
          {facts.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <p className="approval-hint">
        The sandbox&apos;s network policy blocked this. Approving adds the rule to the policy for
        the rest of the conversation and runs the command again.
      </p>
    </>
  )
}
