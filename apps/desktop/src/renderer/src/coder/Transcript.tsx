import { Bot, Brain, ChevronRight, CircleAlert, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type ToolItem, type TranscriptItem, useCoder } from '../store/coder'
import { ApprovalCard } from './ApprovalCard'
import { DiffView } from './DiffView'
import { Markdown } from './Markdown'
import { formatDuration, toolMeta } from './toolMeta'

export function Transcript(): React.JSX.Element {
  const items = useCoder((s) => s.items)
  const approval = useCoder((s) => s.approval)
  const run = useCoder((s) => s.run)
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  // Follow the stream while the user is at the bottom; stop when they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  }, [items, approval, pinned])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Show the "working" dots whenever nothing on screen is visibly moving.
  const last = items[items.length - 1]
  const moving =
    !!last &&
    ((last.kind === 'assistant' && last.streaming) ||
      (last.kind === 'tool' && last.status === 'running') ||
      (last.kind === 'subagent' && last.status === 'running'))
  const thinking = run === 'running' && !moving

  return (
    <div className="transcript" ref={scroller}>
      <div className="transcript-inner">
        {items.map((item, i) => {
          // A turn that only thought before acting folds into the card it led to.
          const next = items[i + 1]
          if (
            item.kind === 'assistant' &&
            !item.text &&
            !item.streaming &&
            next &&
            (next.kind === 'tool' || next.kind === 'subagent')
          )
            return null
          const prev = items[i - 1]
          const thought =
            prev && prev.kind === 'assistant' && !prev.text && !prev.streaming ? prev.reasoning : ''
          return <Item key={`${item.kind}-${item.id}`} item={item} thought={thought} />
        })}
        {thinking && <Working />}
        {approval && <ApprovalCard approval={approval} />}
      </div>
      {!pinned && (
        <button
          className="jump-latest"
          onClick={() => {
            setPinned(true)
            const el = scroller.current
            if (el) el.scrollTop = el.scrollHeight
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  )
}

function Item({ item, thought }: { item: TranscriptItem; thought: string }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <div className="bubble">{item.text}</div>
        </div>
      )
    case 'assistant':
      return <AssistantMessage text={item.text} reasoning={item.reasoning} streaming={item.streaming} />
    case 'tool':
      return <ToolCard tool={item} thought={thought} />
    case 'subagent':
      return <SubagentCard item={item} />
    case 'notice':
      return (
        <div className={`notice is-${item.tone}`}>
          {item.tone === 'error' ? <CircleAlert /> : item.tone === 'warn' ? <TriangleAlert /> : <Info />}
          <span>{item.text}</span>
        </div>
      )
  }
}

function Working(): React.JSX.Element {
  return (
    <div className="working">
      <span className="pulse" />
      <span className="pulse" />
      <span className="pulse" />
    </div>
  )
}

function AssistantMessage({
  text,
  reasoning,
  streaming
}: {
  text: string
  reasoning: string
  streaming: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const onlyThinking = streaming && !text
  return (
    <div className="msg-assistant">
      {reasoning && (
        <div className={open || onlyThinking ? 'thinking is-open' : 'thinking'}>
          <button className="thinking-toggle" onClick={() => setOpen(!open)}>
            <Brain />
            <span>{onlyThinking ? 'Thinking…' : 'Thought process'}</span>
            <ChevronRight className="chev" />
          </button>
          {(open || onlyThinking) && <div className="thinking-body">{reasoning}</div>}
        </div>
      )}
      {text && <Markdown text={text} />}
      {streaming && text && <span className="caret" />}
    </div>
  )
}

const STATUS_LABEL: Record<ToolItem['status'], string> = {
  running: 'Running',
  ok: '',
  error: 'Failed',
  blocked: 'Blocked',
  waiting: 'Needs approval',
  rejected: 'Rejected'
}

export function ToolCard({
  tool,
  compact = false,
  thought = ''
}: {
  tool: ToolItem
  compact?: boolean
  /** The model's reasoning just before this call. */
  thought?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const meta = toolMeta(tool.name, tool.args)
  const hasBody =
    !!thought || tool.output !== undefined || tool.name === 'edit_file' || tool.name === 'write_file'
  return (
    <div className={`tool is-${tool.status}${compact ? ' is-compact' : ''}`}>
      <button className="tool-head" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
        <span className="tool-icon">{meta.icon}</span>
        <span className="tool-verb">{meta.verb}</span>
        <span className="tool-target" title={meta.target}>
          {meta.target}
        </span>
        <span className="tool-meta">
          {tool.status === 'running' ? (
            <span className="spinner" />
          ) : (
            STATUS_LABEL[tool.status] && <span className="tool-status">{STATUS_LABEL[tool.status]}</span>
          )}
          {tool.status === 'ok' && tool.durationMs ? (
            <span className="tool-time">{formatDuration(tool.durationMs)}</span>
          ) : null}
          {hasBody && <ChevronRight className={open ? 'chev is-open' : 'chev'} />}
        </span>
      </button>
      {open && (
        <>
          {thought && (
            <div className="tool-thought">
              <Brain />
              <span>{thought}</span>
            </div>
          )}
          <ToolBody tool={tool} />
        </>
      )}
    </div>
  )
}

function ToolBody({ tool }: { tool: ToolItem }): React.JSX.Element {
  const a = tool.args
  if (tool.name === 'edit_file') {
    return (
      <div className="tool-body">
        <DiffView before={String(a.old_string ?? '')} after={String(a.new_string ?? '')} context={2} />
        {tool.status !== 'ok' && tool.output && <pre className="tool-output">{tool.output}</pre>}
      </div>
    )
  }
  if (tool.name === 'write_file') {
    return (
      <div className="tool-body">
        <DiffView before="" after={String(a.content ?? '')} context={0} maxLines={200} />
        {tool.status !== 'ok' && tool.output && <pre className="tool-output">{tool.output}</pre>}
      </div>
    )
  }
  return (
    <div className="tool-body">
      {tool.name === 'execute' && <pre className="tool-command">$ {String(a.command ?? '')}</pre>}
      <pre className="tool-output">{tool.output || '(no output)'}</pre>
    </div>
  )
}

function SubagentCard({
  item
}: {
  item: Extract<TranscriptItem, { kind: 'subagent' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(item.status === 'running')
  useEffect(() => {
    if (item.status !== 'running') setOpen(false)
  }, [item.status])
  return (
    <div className={`subagent is-${item.status}`}>
      <button className="subagent-head" onClick={() => setOpen(!open)}>
        <span className="subagent-avatar">
          <Bot />
        </span>
        <span className="subagent-title">
          <b>{item.name}</b>
          <span>{item.description}</span>
        </span>
        <span className="tool-meta">
          {item.status === 'running' ? (
            <span className="spinner" />
          ) : (
            <span className="tool-status">
              {item.status === 'done' ? `${item.tools.length} steps` : 'Failed'}
            </span>
          )}
          <ChevronRight className={open ? 'chev is-open' : 'chev'} />
        </span>
      </button>
      {open && (
        <div className="subagent-body">
          {item.tools.map((t) => (
            <ToolCard key={t.id} tool={t} compact />
          ))}
          {item.status === 'running' && item.live && <div className="subagent-live">{item.live}</div>}
          {item.summary && (
            <div className="subagent-summary">
              <Markdown text={item.summary} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
