import { ExternalLink, Globe } from 'lucide-react'
import type { Source } from '../../../shared/contracts'
import { isWebUrl } from '../coder/Markdown'

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Numbered sources, in the order the agent found them. */
export function SourceList({
  sources,
  only
}: {
  sources: Source[]
  /** Show just these ids (the ones a report cites). */
  only?: number[]
}): React.JSX.Element {
  const shown = (only ? sources.filter((s) => only.includes(s.id)) : sources).filter((s) =>
    isWebUrl(s.url)
  )
  return (
    <ol className="sources">
      {shown.map((s) => (
        <li key={s.id}>
          <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
            <span className="source-n">{s.id}</span>
            <SiteMark url={s.url} />
            <span className="source-text">
              <b>{s.title || hostOf(s.url)}</b>
              <span>{hostOf(s.url)}</span>
            </span>
            <ExternalLink className="source-go" />
          </a>
        </li>
      ))}
    </ol>
  )
}

/** The site's initial. Remote favicons stay off: the app's CSP allows no
 *  third-party images, so reading results never pings the sites. */
function SiteMark({ url }: { url: string }): React.JSX.Element {
  const host = hostOf(url)
  let hue = 0
  for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360
  return (
    <span className="source-icon" style={{ background: `hsl(${hue} 55% 45%)` }}>
      {host.charAt(0).toUpperCase()}
    </span>
  )
}

export function SourcesPanel({
  sources,
  running
}: {
  sources: Source[]
  running: boolean
}): React.JSX.Element {
  if (sources.length === 0) {
    return (
      <div className="inspector-empty">
        <Globe />
        <b>{running ? 'Searching…' : 'No sources yet'}</b>
        <span>Every page the agent reads gets a number here. Answers cite them as [1], [2], …</span>
      </div>
    )
  }
  return (
    <div className="sources-panel">
      <div className="sources-head">
        {sources.length} source{sources.length === 1 ? '' : 's'}
        {running && <span className="spinner" />}
      </div>
      <SourceList sources={sources} />
    </div>
  )
}
