import { ArrowUp, ChevronRight, CircleAlert, Square } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileIcon } from '../coder/icons'
import { Markdown } from '../coder/Markdown'
import { SendArt } from '../components/StageArt'
import { type Turn, useKnowledgeChat } from './store'
import { CITE_HREF, citedIn, linkCitations, plural } from './format'

const NONE: Turn[] = []
const CARD_W = 300

interface Props {
  baseId: string
  name: string
  /** Files in the base, and how many of them are still being read. */
  files: number
  processing: number
}

/** Ask a knowledge base; answers cite the passages they come from. */
export function KnowledgeChat({ baseId, name, files, processing }: Props): React.JSX.Element {
  const turns = useKnowledgeChat((s) => s.threads[baseId] ?? NONE)
  const send = useKnowledgeChat((s) => s.send)
  const stop = useKnowledgeChat((s) => s.stop)
  const busy = turns.some((t) => t.state === 'streaming')
  const [draft, setDraft] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // Follow an answer as it arrives, unless the user has scrolled up to read.
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [turns])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const canAsk = files > 0
  const submit = (): void => {
    const text = draft.trim()
    if (!text || busy || !canAsk) return
    setDraft('')
    pinned.current = true
    void send(baseId, text)
  }

  return (
    <section className="kb-chat">
      <div
        className="kb-thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <div className="kb-thread-inner">
          {turns.length === 0 ? (
            <div className="kb-chat-empty">
              <h3>Ask about {name}</h3>
              <p>
                {canAsk
                  ? 'Answers come from these files, and each point links to the passage it came from.'
                  : 'Add a few files, then ask anything about them.'}
              </p>
            </div>
          ) : (
            turns.map((t) =>
              t.role === 'user' ? (
                <div key={t.id} className="msg-user">
                  <div className="bubble">{t.text}</div>
                </div>
              ) : (
                <Answer key={t.id} turn={t} />
              )
            )
          )}
        </div>
      </div>

      <div className="coder-composer kb-composer">
        <div className="composer-box">
          <textarea
            ref={area}
            rows={1}
            value={draft}
            disabled={!canAsk}
            placeholder={canAsk ? `Ask about ${name}…` : 'Add files to ask about them'}
            aria-label={`Ask about ${name}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-row">
            {processing > 0 && (
              <span className="kb-composer-note">
                <span className="spinner is-small" /> Still reading {plural(processing, 'file')}
              </span>
            )}
            <span className="composer-spacer" />
            {busy ? (
              <button className="send is-stop" title="Stop" onClick={() => stop(baseId)}>
                <Square />
              </button>
            ) : (
              <button
                className="send"
                title="Send (Enter)"
                disabled={!draft.trim() || !canAsk}
                onClick={submit}
              >
                <SendArt />
                <ArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/** The citation chip an event happened on, if any. */
function chipAt(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLAnchorElement>(`a[href^="${CITE_HREF}"]`)
}

const numberOf = (chip: HTMLAnchorElement): number =>
  Number(chip.getAttribute('href')?.slice(CITE_HREF.length))

function Answer({ turn }: { turn: Turn }): React.JSX.Element {
  const byN = useMemo(() => new Map(turn.sources.map((s) => [s.n, s])), [turn.sources])
  const text = useMemo(() => linkCitations(turn.text, new Set(byN.keys())), [turn.text, byN])
  const streaming = turn.state === 'streaming'
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const [hover, setHover] = useState<{
    n: number
    left: number
    top: number
    width: number
  } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // Under a finished answer: the passages it cites, or all it was given when it cites none.
  const shown = useMemo(() => {
    if (streaming) return []
    const cited = citedIn(turn.text)
    const some = turn.sources.filter((s) => cited.has(s.n))
    return some.length > 0 ? some : turn.sources
  }, [streaming, turn.text, turn.sources])

  const toggle = (n: number): void =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  const hovered = hover ? byN.get(hover.n) : undefined

  return (
    <div className={`msg-assistant kb-answer${streaming && turn.text ? ' is-streaming' : ''}`}>
      {turn.text && (
        <div
          className="kb-answer-body"
          ref={body}
          onClickCapture={(e) => {
            const chip = chipAt(e.target)
            if (!chip) return
            e.preventDefault()
            e.stopPropagation()
            const n = numberOf(chip)
            setOpen((o) => new Set(o).add(n))
            requestAnimationFrame(() =>
              list.current
                ?.querySelector(`[data-n="${n}"]`)
                ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
            )
          }}
          onMouseOver={(e) => {
            const chip = chipAt(e.target)
            const box = body.current?.getBoundingClientRect()
            if (!chip || !box || !byN.has(numberOf(chip))) {
              setHover(null)
              return
            }
            const n = numberOf(chip)
            if (hover?.n === n) return
            const r = chip.getBoundingClientRect()
            const width = Math.min(CARD_W, box.width)
            const left = Math.max(
              0,
              Math.min(r.left - box.left + r.width / 2 - width / 2, box.width - width)
            )
            setHover({ n, left, top: r.bottom - box.top + 6, width })
          }}
          onMouseLeave={() => setHover(null)}
        >
          <Markdown text={text} />
          {hovered && hover && (
            <div
              className="kb-cite-card"
              role="tooltip"
              style={{ left: hover.left, top: hover.top, width: hover.width }}
            >
              <div className="kb-cite-card-head">
                <FileIcon name={hovered.file_name} className="kb-source-icon" />
                <b>{hovered.file_name}</b>
                {hovered.page !== null && <span>p. {hovered.page}</span>}
              </div>
              <p>{hovered.excerpt}</p>
            </div>
          )}
        </div>
      )}

      {streaming && !turn.text && (
        <div className="kb-thinking">
          <span className="spinner is-small" />
          {turn.sources.length > 0
            ? `Reading ${plural(turn.sources.length, 'passage')}…`
            : 'Searching the files…'}
        </div>
      )}

      {turn.state === 'error' && (
        <div className="kb-answer-error">
          <CircleAlert />
          <span>{turn.error || 'Something went wrong.'}</span>
        </div>
      )}
      {turn.state === 'stopped' && <div className="kb-answer-note">Stopped</div>}

      {shown.length > 0 && (
        <div className="kb-sources" ref={list}>
          <div className="kb-sources-label">Sources</div>
          {shown.map((s) => {
            const isOpen = open.has(s.n)
            return (
              <div
                key={s.n}
                data-n={s.n}
                className={`kb-source${isOpen ? ' is-open' : ''}${hover?.n === s.n ? ' is-hot' : ''}`}
              >
                <button
                  className="kb-source-row"
                  onClick={() => toggle(s.n)}
                  title={isOpen ? undefined : s.excerpt}
                  aria-expanded={isOpen}
                >
                  <span className="kb-chip">{s.n}</span>
                  <FileIcon name={s.file_name} className="kb-source-icon" />
                  <span className="kb-source-name">{s.file_name}</span>
                  {s.page !== null && <span className="kb-source-page">p. {s.page}</span>}
                  <ChevronRight className="kb-source-chev" />
                </button>
                {isOpen && <p className="kb-source-excerpt">{s.excerpt}</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
