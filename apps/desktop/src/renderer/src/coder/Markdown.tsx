import { Check, Copy, FileDown } from 'lucide-react'
import { Children, createContext, memo, useContext, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { Source } from '../../../shared/contracts'

const remarkPlugins = [remarkGfm]
const rehypePlugins = [[rehypeHighlight, { detect: true, ignoreMissing: true }]] as never

/** The numbered sources of the session on screen; turns `[n]` into links. */
export const CitationContext = createContext<Source[]>([])

/**
 * Turns the path of a file an agent saved in its sandbox (`/outputs/chart.png`)
 * into a URL the app can load; null where the session has no sandbox.
 */
export const OutputContext = createContext<((path: string) => string) | null>(null)

const isOutput = (url: string | null | undefined): url is string => !!url?.startsWith('/outputs/')

const CITE = /(?<![\w\]])\[(\d{1,3})\](?![(:[])/g

/** Link `[n]` to source n, outside code. */
function linkCitations(text: string, ids: Set<number>): string {
  if (ids.size === 0 || !text.includes('[')) return text
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(CITE, (whole, n: string) => (ids.has(Number(n)) ? `[${n}](#cite-${n})` : whole))
    )
    .join('')
}

/** Only web links from search results; never `javascript:` or `file:`. */
export const isWebUrl = (url: string | null | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url)

/** Assistant prose: GitHub-flavoured Markdown with highlighted code. */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  const sources = useContext(CitationContext)
  const output = useContext(OutputContext)
  const byId = new Map(sources.filter((s) => isWebUrl(s.url)).map((s) => [s.id, s]))
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // Models write <br> for line breaks inside table cells; honour it.
          td: ({ children }) => <td>{withBreaks(children)}</td>,
          th: ({ children }) => <th>{withBreaks(children)}</th>,
          img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src : ''
            if (isOutput(url)) {
              if (!output) return <span className="md-output-missing">{alt || url}</span>
              return (
                <a className="md-output" href={output(url)} target="_blank" rel="noreferrer">
                  <img src={output(url)} alt={alt ?? ''} loading="lazy" />
                </a>
              )
            }
            return <img src={url} alt={alt ?? ''} loading="lazy" />
          },
          a: ({ href, children }) => {
            if (isOutput(href) && output) {
              return (
                <a className="md-file" href={output(href)} download={href.split('/').pop()}>
                  <FileDown />
                  {children}
                </a>
              )
            }
            const cited = href?.startsWith('#cite-') ? byId.get(Number(href.slice(6))) : undefined
            if (cited) {
              return (
                <a
                  className="cite"
                  href={cited.url}
                  target="_blank"
                  rel="noreferrer"
                  title={cited.title || cited.url}
                >
                  {cited.id}
                </a>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {linkCitations(text, new Set(byId.keys()))}
      </ReactMarkdown>
    </div>
  )
})

const BR = /<br\s*\/?>/i

/** Turn literal `<br>` in a cell's text into real line breaks; nothing else. */
function withBreaks(children: React.ReactNode): React.ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string' || !BR.test(child)) return child
    const parts = child.split(new RegExp(BR.source, 'gi'))
    return parts.flatMap((part, i) => (i === 0 ? [part] : [<br key={i} />, part]))
  })
}

/** A fenced code block with a copy button. */
function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1400)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <div className="md-pre">
      <pre ref={ref}>{children}</pre>
      <button
        className="md-copy"
        title={done ? 'Copied' : 'Copy code'}
        onClick={() => {
          const text = ref.current?.textContent ?? ''
          void navigator.clipboard.writeText(text).then(() => setDone(true))
        }}
      >
        {done ? <Check /> : <Copy />}
      </button>
    </div>
  )
}
