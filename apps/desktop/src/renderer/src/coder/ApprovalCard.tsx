import { Check, FilePen, ShieldAlert, SquareTerminal, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
  other: <ShieldAlert />
}

const TITLE = {
  edit: 'Edit a file',
  delete: 'Delete a file',
  command: 'Run a command',
  other: 'Use a tool'
}

export function ApprovalCard({ approval }: { approval: ApprovalRequired }): React.JSX.Element {
  const decide = useCoder((s) => s.decide)
  const requests = approval.requests
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

  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldAlert />
        <b>{requests.length > 1 ? `${requests.length} actions need your approval` : 'Coder needs your approval'}</b>
      </div>
      {requests.map((r) => (
        <RequestView
          key={r.index}
          request={r}
          scope={scope[r.index] ?? scopes(r)[0].pattern}
          onScope={(p) => setScope({ ...scope, [r.index]: p })}
        />
      ))}
      {rejecting ? (
        <div className="approval-reject">
          <input
            autoFocus
            placeholder="Tell the Coder what to do instead (optional)"
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
            <X /> Reject
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          <button
            ref={approveRef}
            className="btn btn-primary"
            onClick={() => submit('approve')}
            disabled={busy}
          >
            <Check /> {requests.length > 1 ? 'Approve all' : 'Approve'}
            <kbd>Y</kbd>
          </button>
          <button className="btn" onClick={() => submit('approve', true)} disabled={busy}>
            Always allow
          </button>
          <button className="btn btn-ghost" onClick={() => setRejecting(true)} disabled={busy}>
            Reject <kbd>N</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

function RequestView({
  request,
  scope,
  onScope
}: {
  request: ApprovalRequest
  scope: string
  onScope: (pattern: string) => void
}): React.JSX.Element {
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

  const options = scopes(request)
  return (
    <div className="approval-item">
      <div className="approval-title">
        <span className={`approval-kind is-${request.kind}`}>{ICON[request.kind]}</span>
        <span>{TITLE[request.kind]}</span>
        {path && <code>{path.replace(/^\//, '')}</code>}
      </div>
      {request.kind === 'command' && (
        <pre className="approval-command">
          $ {String(request.args.command ?? request.args.message ?? request.description)}
        </pre>
      )}
      {diff && (
        <div className="approval-diff">
          <DiffView before={diff.before} after={diff.after} context={3} maxLines={300} />
        </div>
      )}
      {request.kind === 'delete' && <p className="approval-note">The file will be removed from the project.</p>}
      {options.length > 1 && (
        <label className="approval-scope">
          <span>“Always allow” covers</span>
          <select value={scope} onChange={(e) => onScope(e.target.value)}>
            {options.map((o) => (
              <option key={o.label} value={o.pattern}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
