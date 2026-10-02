import { Check, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { FileContent, FileDiff } from '../../../shared/contracts'
import { api } from '../api'
import { useCoder } from '../store/coder'
import { DiffView } from './DiffView'
import { highlightLines, languageOf } from './highlight'
import { FileIcon } from './icons'
import { Markdown } from './Markdown'

type View = 'code' | 'preview' | 'diff'

export function FileViewer({ path }: { path: string }): React.JSX.Element {
  const projectId = useCoder((s) => s.projectId)
  const project = useCoder((s) => s.projects.find((p) => p.id === s.projectId))
  const sessionId = useCoder((s) => s.sessionId)
  const change = useCoder((s) => s.changes.find((c) => c.path === path))
  const run = useCoder((s) => s.run)
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isMarkdown = /\.mdx?$/i.test(path)
  const [view, setView] = useState<View>(change ? 'diff' : 'code')

  // Reload when the agent touches the file, or a run ends.
  const stamp = `${change?.additions ?? 0}:${change?.deletions ?? 0}:${run === 'idle'}`
  useEffect(() => {
    if (!projectId) return
    let live = true
    void api.projects.file(projectId, path).then((res) => {
      if (!live) return
      if (res.ok) {
        setFile(res.data)
        setError(null)
      } else setError(res.error)
    })
    return () => {
      live = false
    }
  }, [projectId, path, stamp])

  useEffect(() => {
    if (view === 'diff' && !change) setView('code')
  }, [view, change])

  const views: { id: View; label: string }[] = [
    { id: 'code', label: 'Code' },
    ...(isMarkdown ? [{ id: 'preview' as View, label: 'Preview' }] : []),
    ...(change && sessionId ? [{ id: 'diff' as View, label: 'Changes' }] : [])
  ]

  const parts = path.split('/')
  const name = parts.pop() ?? path
  const lineCount = file ? file.content.split('\n').length : 0

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="crumbs" title={path}>
          {parts.map((p, i) => (
            <span key={i} className="crumb">
              {p}
              <ChevronRight />
            </span>
          ))}
          <span className="crumb is-file">
            <FileIcon name={name} />
            {name}
          </span>
        </div>
        <div className="viewer-actions">
          {views.length > 1 && (
            <div className="seg" role="tablist">
              {views.map((v) => (
                <button
                  key={v.id}
                  role="tab"
                  aria-selected={view === v.id}
                  className={view === v.id ? 'is-active' : ''}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <CopyButton text={path} title="Copy path" />
          {window.polly?.revealPath && project && (
            <button
              className="icon-btn"
              title="Reveal in Finder"
              onClick={() => void window.polly?.revealPath(`${project.path}/${path}`)}
            >
              <ExternalLink />
            </button>
          )}
        </div>
      </div>

      <div className="viewer-body">
        {error ? (
          <div className="inspector-empty">
            <b>Can’t open this file</b>
            <span>{error}</span>
          </div>
        ) : !file ? (
          <div className="viewer-loading" />
        ) : view === 'diff' && sessionId ? (
          <FileDiffView sessionId={sessionId} path={path} stamp={stamp} />
        ) : view === 'preview' ? (
          <div className="viewer-preview">
            <Markdown text={file.content} />
          </div>
        ) : (
          <CodeView code={file.content} path={path} />
        )}
      </div>

      {file && (
        <div className="viewer-foot">
          <span>{languageOf(path) ?? 'Plain text'}</span>
          <span>
            {lineCount.toLocaleString()} line{lineCount === 1 ? '' : 's'}
          </span>
          {file.truncated && <span className="is-warn">Truncated — the file is larger than 512 KB</span>}
          {change && <span className={`viewer-change is-${change.kind}`}>{change.kind} this session</span>}
        </div>
      )}
    </div>
  )
}

function CodeView({ code, path }: { code: string; path: string }): React.JSX.Element {
  const lines = useMemo(() => highlightLines(code, path), [code, path])
  const digits = String(lines.length).length
  return (
    <div className="code" style={{ '--gutter': `${digits + 2}ch` } as React.CSSProperties}>
      {lines.map((html, i) => (
        <div key={i} className="code-line">
          <span className="code-no">{i + 1}</span>
          <span className="code-text hljs" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
        </div>
      ))}
    </div>
  )
}

function FileDiffView({
  sessionId,
  path,
  stamp
}: {
  sessionId: string
  path: string
  stamp: string
}): React.JSX.Element {
  const [diff, setDiff] = useState<FileDiff | null>(null)
  useEffect(() => {
    let live = true
    void api.sessions.diff(sessionId, path).then((res) => {
      if (live && res.ok) setDiff(res.data)
    })
    return () => {
      live = false
    }
  }, [sessionId, path, stamp])
  if (!diff) return <div className="viewer-loading" />
  if (diff.binary) return <div className="diff-empty">Binary or very large file.</div>
  return <DiffView before={diff.before} after={diff.after} path={path} />
}

export function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1400)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <button
      className="icon-btn"
      title={done ? 'Copied' : title}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setDone(true))
      }}
    >
      {done ? <Check /> : <Copy />}
    </button>
  )
}
