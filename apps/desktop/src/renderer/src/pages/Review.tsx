import {
  CircleAlert,
  GitPullRequest,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentSummary, GitHubStatus, PRFacts } from '../../../shared/contracts'
import { api } from '../api'
import { isWebUrl } from '../coder/Markdown'
import { TranscriptView } from '../coder/Transcript'
import { AgentAvatar } from '../components/AgentAvatar'
import { Workspace } from '../components/Splitter'
import { AgentComposer } from '../research/AgentComposer'
import { AgentRail } from '../research/AgentRail'
import { ScoreCard } from '../research/Cards'
import { SourcesPanel } from '../research/Sources'
import { useReview } from '../store/agentSession'

export const PR_URL = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i

export function Review({
  agents,
  onConnect
}: {
  agents: AgentSummary[]
  /** Open Integrations to connect GitHub. */
  onConnect: () => void
}): React.JSX.Element {
  const boot = useReview((s) => s.boot)
  const session = useReview((s) => s.session)
  const sessionId = useReview((s) => s.sessionId)
  const items = useReview((s) => s.items)
  const run = useReview((s) => s.run)
  const sources = useReview((s) => s.sources)
  const scorecard = useReview((s) => s.scorecard)
  const pr = useReview((s) => s.pr)
  const error = useReview((s) => s.error)
  const clearError = useReview((s) => s.clearError)
  const [panel, setPanel] = useState(true)

  useEffect(() => {
    void boot()
  }, [boot])

  const agent = agents.find((a) => a.id === 'reviewer')
  const open = !!sessionId

  return (
    <Workspace
      rail={
        <AgentRail
          store={useReview}
          title="Reviews"
          subtitle="Score a GitHub pull request"
          icon={<GitPullRequest />}
          newLabel="New review"
          empty="No pull requests reviewed yet."
        />
      }
      panel={
        panel && open ? (
          <aside className="inspector">
            <div className="inspector-tabs">
              <span className="itab is-active">Pull request</span>
            </div>
            <div className="inspector-body">
              {pr && <PRPanel pr={pr} />}
              <SourcesPanel sources={sources} running={run === 'running'} />
            </div>
          </aside>
        ) : null
      }
    >
      <section className="chat">
        <header className="chat-head">
          {agent && <AgentAvatar agent={agent} size={24} active={run === 'running'} />}
          <div className="chat-title">
            <b>{session?.title || 'New review'}</b>
            {agent && <span>{agent.name}</span>}
          </div>
          <span className={`run-state is-${run}`}>{run === 'running' ? 'Reviewing' : ''}</span>
          {open && (
            <button
              className="icon-btn"
              title={panel ? 'Hide panel' : 'Show panel'}
              onClick={() => setPanel(!panel)}
            >
              {panel ? <PanelRightClose /> : <PanelRightOpen />}
            </button>
          )}
        </header>

        {error && (
          <div className="banner is-error">
            <CircleAlert />
            <span>{error}</span>
            {/github|token|rate limit|401|403|404/i.test(error) && (
              <button className="btn btn-sm" onClick={onConnect}>
                Connect GitHub
              </button>
            )}
            <button className="icon-btn" onClick={clearError} title="Dismiss">
              <X />
            </button>
          </div>
        )}

        {!open ? (
          <ReviewStart onConnect={onConnect} />
        ) : (
          <>
            <TranscriptView
              agent={agent}
              items={items}
              run={run}
              sources={sources}
              footer={
                scorecard && sessionId ? (
                  <ScoreCard card={scorecard} sessionId={sessionId} onConnect={onConnect} />
                ) : null
              }
            />
            <AgentComposer store={useReview} placeholder="Ask about this review…" />
          </>
        )}
      </section>
    </Workspace>
  )
}

function ReviewStart({ onConnect }: { onConnect: () => void }): React.JSX.Element {
  const review = useReview((s) => s.review)
  const starting = useReview((s) => s.starting)
  const [url, setUrl] = useState('')
  const [github, setGithub] = useState<GitHubStatus | null>(null)

  useEffect(() => {
    void api.integrations.status().then((r) => r.ok && setGithub(r.data.github))
  }, [])

  const valid = PR_URL.test(url.trim())

  return (
    <div className="coder-starters">
      <div className="welcome-mark is-review">
        <GitPullRequest />
      </div>
      <h2>
        Score a <em>pull request</em>
      </h2>
      <p className="research-blurb">
        The Reviewer reads the diff, checks CI, looks up the libraries it touches and scores the PR
        out of 100 against a fixed rubric, on Nemotron Ultra.
      </p>
      <form
        className="pr-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void review(url).then((ok) => ok && setUrl(''))
        }}
      >
        <GitPullRequest />
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          spellCheck={false}
        />
        <button className="btn btn-primary" type="submit" disabled={!valid || starting}>
          {starting ? 'Fetching PR…' : 'Review'}
        </button>
      </form>
      <div className="welcome-points">
        {github?.connected ? (
          <span>
            <ShieldCheck /> Signed in to GitHub as @{github.login}
          </span>
        ) : (
          <span>
            Public PRs work without signing in.{' '}
            <button className="link" onClick={onConnect}>
              Connect GitHub
            </button>{' '}
            for private repos, higher rate limits and posting the score.
          </span>
        )}
      </div>
    </div>
  )
}

const CI_LABEL: Record<PRFacts['ci']['state'], string> = {
  passing: 'Passing',
  failing: 'Failing',
  pending: 'Pending',
  none: 'No checks'
}

function PRPanel({ pr }: { pr: PRFacts }): React.JSX.Element {
  return (
    <div className="session-panel pr-panel">
      <section>
        <h4>Pull request</h4>
        {isWebUrl(pr.url) ? (
          <a className="pr-title" href={pr.url} target="_blank" rel="noreferrer">
            {pr.title || pr.slug}
          </a>
        ) : (
          <b>{pr.title || pr.slug}</b>
        )}
        <dl className="kv">
          <dt>Repo</dt>
          <dd>{pr.slug}</dd>
          {pr.author && (
            <>
              <dt>Author</dt>
              <dd>@{pr.author}</dd>
            </>
          )}
          {pr.base && pr.head && (
            <>
              <dt>Branch</dt>
              <dd>
                {pr.head} → {pr.base}
              </dd>
            </>
          )}
          <dt>Size</dt>
          <dd>
            <span className="adds">+{pr.additions}</span> <span className="dels">−{pr.deletions}</span>{' '}
            in {pr.changed_files} file{pr.changed_files === 1 ? '' : 's'}
          </dd>
          <dt>CI</dt>
          <dd>
            <span className={`ci is-${pr.ci.state}`}>{CI_LABEL[pr.ci.state]}</span>
            {pr.ci.failing?.length ? ` · ${pr.ci.failing.join(', ')}` : ''}
          </dd>
          <dt>Tests</dt>
          <dd>
            {pr.tests_touched?.length
              ? `${pr.tests_touched.length} test file${pr.tests_touched.length === 1 ? '' : 's'}`
              : 'None changed'}
          </dd>
          {pr.partial && (
            <>
              <dt>Note</dt>
              <dd>Very large: reviewed in part</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  )
}
