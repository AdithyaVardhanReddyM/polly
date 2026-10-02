import {
  Check,
  Copy,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  LogOut,
  Search
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceStart, IntegrationsStatus } from '../../../shared/contracts'
import { api } from '../api'
import { PageHead } from '../components/PageHead'

const LATER = [
  { name: 'Gmail', what: 'Read, triage and draft email' },
  { name: 'Google Calendar', what: 'Events, availability and scheduling' },
  { name: 'Slack', what: 'Channels, threads and messages' },
  { name: 'Notion', what: 'Pages and databases' },
  { name: 'Linear', what: 'Issues, projects and cycles' },
  { name: 'Google Drive', what: 'Docs, sheets and files' }
]

export function Integrations(): React.JSX.Element {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await api.integrations.status()
    if (res.ok) {
      setStatus(res.data)
      setError(null)
    } else setError(res.error)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="page">
      <PageHead
        title="Integrations"
        subtitle="Connect your accounts once; give each agent only the ones it needs."
      />
      {error && <div className="empty">{error}</div>}

      <div className="integration-grid is-live">
        <GitHubCard status={status} onChange={load} />
        <div className="integration is-card">
          <div className="integration-top">
            <span className="integration-logo">
              <Search />
            </span>
            <div className="row-body">
              <div className="row-title">Tavily</div>
              <div className="row-why">Web search and page extraction for Research and reviews</div>
            </div>
            <span className={status?.tavily.configured ? 'status status-ready' : 'status status-planned'}>
              {status?.tavily.configured ? 'Connected' : 'Not set'}
            </span>
          </div>
          {status && !status.tavily.configured && (
            <p className="muted integration-note">
              Add <code>TAVILY_API_KEY</code> to <code>.env</code> and restart the server.
            </p>
          )}
        </div>
      </div>

      <div className="section-head">
        <h2>Coming later</h2>
      </div>
      <div className="integration-grid">
        {LATER.map((i) => (
          <div key={i.name} className="integration">
            <span className="integration-logo">{i.name.charAt(0)}</span>
            <div className="row-body">
              <div className="row-title">{i.name}</div>
              <div className="row-why">{i.what}</div>
            </div>
            <button className="btn" disabled>
              Connect
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const SOURCE_LABEL = {
  oauth: 'Signed in with GitHub',
  pat: 'Personal access token',
  env: 'GITHUB_TOKEN in .env'
}

function GitHubCard({
  status,
  onChange
}: {
  status: IntegrationsStatus | null
  onChange: () => Promise<void>
}): React.JSX.Element {
  const gh = status?.github
  const [flow, setFlow] = useState<DeviceStart | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef<string | null>(null)

  const stopPolling = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    active.current = null
  }
  useEffect(() => stopPolling, [])

  const poll = (f: DeviceStart, interval: number): void => {
    timer.current = setTimeout(async () => {
      const res = await api.integrations.githubPoll(f.flow_id)
      if (active.current !== f.flow_id) return // cancelled meanwhile
      if (!res.ok) {
        setNote(res.error)
        setFlow(null)
        return
      }
      const p = res.data
      if (p.status === 'pending') {
        poll(f, p.interval ?? interval)
      } else if (p.status === 'connected') {
        setFlow(null)
        setNote(null)
        await onChange()
      } else {
        setFlow(null)
        setNote(
          p.message ??
            (p.status === 'expired' ? 'The code expired. Try again.' : 'Sign-in was cancelled.')
        )
      }
    }, Math.max(interval, 1) * 1000)
  }

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    const res = await api.integrations.githubDevice()
    setBusy(false)
    if (!res.ok) {
      setNote(res.error)
      return
    }
    setFlow(res.data)
    active.current = res.data.flow_id
    window.open(res.data.verification_uri, '_blank')
    poll(res.data, res.data.interval)
  }

  const saveToken = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    const res = await api.integrations.githubToken(token.trim())
    setBusy(false)
    if (!res.ok) {
      setNote(res.error)
      return
    }
    setToken('')
    setTokenOpen(false)
    await onChange()
  }

  const disconnect = async (): Promise<void> => {
    const res = await api.integrations.githubDisconnect()
    if (!res.ok) setNote(res.error)
    await onChange()
  }

  return (
    <div className="integration is-card is-github">
      <div className="integration-top">
        <span className="integration-logo">
          <GitPullRequest />
        </span>
        <div className="row-body">
          <div className="row-title">GitHub</div>
          <div className="row-why">Read pull requests for reviews and post the score as a comment</div>
        </div>
        <span className={gh?.connected ? 'status status-ready' : 'status status-planned'}>
          {gh?.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {gh?.connected ? (
        <div className="integration-body">
          <p>
            <b>@{gh.login ?? 'unknown'}</b>
            <span className="muted"> · {gh.source ? SOURCE_LABEL[gh.source] : 'Connected'}</span>
            {gh.scopes.length > 0 && <span className="muted"> · scopes: {gh.scopes.join(', ')}</span>}
          </p>
          {gh.source === 'env' ? (
            <p className="muted">Remove GITHUB_TOKEN from .env to disconnect.</p>
          ) : (
            <button className="btn btn-sm" onClick={() => void disconnect()}>
              <LogOut /> Disconnect
            </button>
          )}
        </div>
      ) : flow ? (
        <div className="integration-body device">
          <p className="muted">Enter this code on GitHub, then come back. Polly checks every few seconds.</p>
          <div className="device-code">
            <code>{flow.user_code}</code>
            <button
              className="icon-btn"
              title="Copy code"
              onClick={() =>
                void navigator.clipboard.writeText(flow.user_code).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }
            >
              {copied ? <Check /> : <Copy />}
            </button>
          </div>
          <div className="integration-actions">
            <button
              className="btn btn-sm btn-primary"
              onClick={() => window.open(flow.verification_uri, '_blank')}
            >
              <ExternalLink /> Open {flow.verification_uri.replace(/^https?:\/\//, '')}
            </button>
            <span className="spinner" />
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                stopPolling()
                setFlow(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="integration-body">
          <div className="integration-actions">
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || !gh?.device_flow_available}
              title={
                gh?.device_flow_available
                  ? 'Sign in with the GitHub Device Flow'
                  : 'Set GITHUB_CLIENT_ID (an OAuth App with Device Flow enabled) in .env'
              }
              onClick={() => void signIn()}
            >
              <GitPullRequest /> Sign in with GitHub
            </button>
            <button className="btn btn-sm" onClick={() => setTokenOpen(!tokenOpen)}>
              <KeyRound /> Use a token
            </button>
          </div>
          {gh && !gh.device_flow_available && (
            <p className="muted">
              To sign in, set <code>GITHUB_CLIENT_ID</code> in <code>.env</code>, or paste a
              personal access token.
            </p>
          )}
          {tokenOpen && (
            <form
              className="token-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (token.trim()) void saveToken()
              }}
            >
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_… (read pull requests; write to comment)"
              />
              <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !token.trim()}>
                Save
              </button>
            </form>
          )}
        </div>
      )}
      {note && <p className="post-error integration-note">{note}</p>}
    </div>
  )
}
