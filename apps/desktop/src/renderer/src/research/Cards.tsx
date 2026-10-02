import {
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  GitPullRequest,
  MessageSquarePlus,
  ThumbsUp,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChangeReport, ReviewFinding, Scorecard, Severity } from '../../../shared/contracts'
import { api } from '../api'
import { CitationContext, isWebUrl, Markdown } from '../coder/Markdown'
import { SourceList } from './Sources'

const VERDICT: Record<Scorecard['verdict'], string> = {
  approve: 'Approve',
  comment: 'Comment',
  request_changes: 'Request changes'
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export function SeverityTag({ severity }: { severity: Severity }): React.JSX.Element {
  return <span className={`sev is-${severity}`}>{severity}</span>
}

function cited(findings: { sources: number[] }[]): number[] {
  return [...new Set(findings.flatMap((f) => f.sources))].sort((a, b) => a - b)
}

/** The Reviewer's verdict on a pull request. */
export function ScoreCard({
  card,
  sessionId,
  onConnect
}: {
  card: Scorecard
  sessionId: string
  /** Open Integrations to connect GitHub. */
  onConnect: () => void
}): React.JSX.Element {
  const [posting, setPosting] = useState(false)
  const capped = card.raw_total - card.total >= 0.5
  const findings = [...card.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  )
  const refs = cited(card.findings)

  return (
    <CitationContext.Provider value={card.sources}>
      <article className="scorecard">
        <header className="score-head">
          <div className={`grade is-${card.grade}`}>{card.grade}</div>
          <div className="score-total">
            <b>
              {card.total}
              <span>/100</span>
            </b>
            {capped && (
              <span className="muted" title="Before Polly's caps">
                {card.raw_total} before caps
              </span>
            )}
          </div>
          <span className={`verdict is-${card.verdict}`}>{VERDICT[card.verdict]}</span>
          <span className="score-spacer" />
          {card.pr.url && isWebUrl(card.pr.url) && (
            <a className="btn btn-sm" href={card.pr.url} target="_blank" rel="noreferrer">
              <GitPullRequest /> {card.pr.slug ?? 'Pull request'}
            </a>
          )}
        </header>

        {card.summary && (
          <div className="score-summary">
            <Markdown text={card.summary} />
          </div>
        )}

        {card.adjustments.length > 0 && (
          <ul className="adjustments">
            {card.adjustments.map((a) => (
              <li key={a}>
                <TriangleAlert /> {a}
              </li>
            ))}
          </ul>
        )}

        <div className="categories">
          {card.categories.map((c) => (
            <div key={c.key} className="category">
              <div className="category-top">
                <b>{c.label}</b>
                <span className="weight">{c.weight}%</span>
                <span className="category-score">
                  {c.score !== c.model_score && (
                    <s title="The model's score, before a cap">{c.model_score}</s>
                  )}
                  {c.score}/10
                </span>
              </div>
              <div className="score-bar">
                <div className={barTone(c.score)} style={{ width: `${c.score * 10}%` }} />
              </div>
              <p>{c.rationale}</p>
              {c.evidence.length > 0 && (
                <div className="evidence">
                  {c.evidence.slice(0, 6).map((e) => (
                    <code key={e}>{e}</code>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {card.strengths.length > 0 && (
          <section className="score-section">
            <h4>
              <ThumbsUp /> Strengths
            </h4>
            <ul className="strengths">
              {card.strengths.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        )}

        {findings.length > 0 && (
          <section className="score-section">
            <h4>
              <CircleAlert /> Findings
            </h4>
            <div className="findings">
              {findings.map((f, i) => (
                <Finding key={`${f.title}-${i}`} finding={f} />
              ))}
            </div>
          </section>
        )}

        {refs.length > 0 && (
          <section className="score-section">
            <h4>Sources</h4>
            <SourceList sources={card.sources} only={refs} />
          </section>
        )}

        <footer className="score-actions">
          <CopyMarkdown sessionId={sessionId} />
          <button className="btn btn-sm btn-primary" onClick={() => setPosting(true)}>
            <MessageSquarePlus /> Post as PR comment
          </button>
        </footer>
      </article>
      {posting && (
        <PostDialog sessionId={sessionId} onClose={() => setPosting(false)} onConnect={onConnect} />
      )}
    </CitationContext.Provider>
  )
}

function barTone(score: number): string {
  return score >= 8 ? 'is-good' : score >= 6 ? 'is-ok' : score >= 4 ? 'is-weak' : 'is-bad'
}

function Finding({ finding: f }: { finding: ReviewFinding }): React.JSX.Element {
  return (
    <div className="finding">
      <div className="finding-top">
        <SeverityTag severity={f.severity} />
        <b>{f.title}</b>
        {f.file && (
          <code className="finding-where">
            {f.file}
            {f.line ? `:${f.line}` : ''}
          </code>
        )}
      </div>
      <Markdown text={f.detail} />
      {f.suggestion && (
        <div className="finding-fix">
          <span>Suggestion</span>
          <Markdown text={f.suggestion} />
        </div>
      )}
    </div>
  )
}

function CopyMarkdown({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn btn-sm"
      onClick={() =>
        void api.sessions.commentPreview(sessionId).then(async (res) => {
          if (!res.ok) return
          await navigator.clipboard.writeText(res.data.markdown)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
    >
      {done ? <Check /> : <Copy />} {done ? 'Copied' : 'Copy as Markdown'}
    </button>
  )
}

/** Preview first; the click on "Post" is the approval. Polly never posts on its own. */
function PostDialog({
  sessionId,
  onClose,
  onConnect
}: {
  sessionId: string
  onClose: () => void
  onConnect: () => void
}): React.JSX.Element {
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [state, setState] = useState<'idle' | 'posting' | 'posted'>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.sessions.commentPreview(sessionId).then((r) =>
      r.ok ? setMarkdown(r.data.markdown) : setError(r.error)
    )
    void api.integrations.status().then((r) => setConnected(r.ok ? r.data.github.connected : false))
  }, [sessionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state !== 'posting') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, state])

  const post = async (): Promise<void> => {
    setState('posting')
    setError(null)
    const res = await api.sessions.postComment(sessionId)
    if (res.ok) {
      setUrl(res.data.url)
      setState('posted')
    } else {
      setError(res.error)
      setState('idle')
    }
  }

  return (
    <div className="peek-backdrop" onMouseDown={() => state !== 'posting' && onClose()}>
      <div className="peek post-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="peek-head">
          <MessageSquarePlus />
          <code>Comment preview</code>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)" disabled={state === 'posting'}>
            <X />
          </button>
        </div>
        <div className="post-body">
          {markdown === null ? (
            <div className="muted">{error ?? 'Loading…'}</div>
          ) : (
            <Markdown text={markdown} />
          )}
        </div>
        <div className="post-foot">
          {error && markdown !== null && (
            <span className="post-error">
              <CircleAlert /> {error}
            </span>
          )}
          {state === 'posted' ? (
            <>
              <span className="post-ok">
                <Check /> Posted to the pull request.
              </span>
              {url && isWebUrl(url) && (
                <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open on GitHub
                </a>
              )}
              <button className="btn btn-sm btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          ) : connected === false ? (
            <>
              <span className="muted">Connect GitHub to post comments.</span>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  onClose()
                  onConnect()
                }}
              >
                Connect GitHub
              </button>
            </>
          ) : (
            <>
              <span className="muted">Posts exactly this, as you, on the pull request.</span>
              <button className="btn btn-sm" onClick={onClose} disabled={state === 'posting'}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={markdown === null || state === 'posting' || connected === null}
                onClick={() => void post()}
              >
                {state === 'posting' ? 'Posting…' : 'Post comment'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- change research ----------

const REPORT_VERDICT: Record<ChangeReport['verdict'], string> = {
  looks_good: 'Looks good',
  needs_attention: 'Needs attention',
  risky: 'Risky'
}

/** What change research found about a Coder run, plus a PR description. */
export function ReportCard({ report }: { report: ChangeReport }): React.JSX.Element {
  const findings = [...report.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  )
  const refs = cited(report.findings)
  return (
    <CitationContext.Provider value={report.sources}>
      <div className="report">
        <div className="report-head">
          <span className={`verdict is-${report.verdict}`}>{REPORT_VERDICT[report.verdict]}</span>
        </div>
        <Markdown text={report.summary} />

        {findings.length > 0 && (
          <div className="findings is-compact">
            {findings.map((f, i) => (
              <div key={`${f.title}-${i}`} className="finding">
                <div className="finding-top">
                  <SeverityTag severity={f.severity} />
                  <b>{f.title}</b>
                </div>
                {f.file && <code className="finding-where">{f.file}</code>}
                <Markdown text={f.detail} />
              </div>
            ))}
          </div>
        )}

        <PullRequestDraft title={report.pr_title} body={report.pr_description} />

        {refs.length > 0 && (
          <>
            <h4 className="report-label">Sources</h4>
            <SourceList sources={report.sources} only={refs} />
          </>
        )}
      </div>
    </CitationContext.Provider>
  )
}

function PullRequestDraft({ title, body }: { title: string; body: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'title' | 'body' | null>(null)
  const copy = (what: 'title' | 'body', text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  return (
    <div className="pr-draft">
      <div className="pr-draft-head">
        <GitPullRequest />
        <b title={title}>{title}</b>
      </div>
      <div className="pr-draft-actions">
        <button className="btn btn-sm" onClick={() => copy('title', title)}>
          {copied === 'title' ? <Check /> : <Copy />} Title
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => copy('body', body)}>
          {copied === 'body' ? <Check /> : <Copy />} PR description
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Preview'}
        </button>
      </div>
      {open && (
        <div className="pr-draft-body">
          <Markdown text={body} />
        </div>
      )}
    </div>
  )
}
