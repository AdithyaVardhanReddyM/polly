import { ArrowUp, Check, Copy, Loader2, RotateCw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CopilotEvent } from '../../../shared/contracts'
import type { OverlayPayload } from '../../../shared/copilot'
import type { Rect } from '../../../shared/sense'
import { copilotApi } from '../notch/api'

const bridge = window.polly?.copilot

type Bubble = NonNullable<OverlayPayload['bubble']>

const EDIT_PRESETS = [
  'Fix spelling and grammar',
  'Make it shorter',
  'Make it friendlier',
  'Make it more professional',
  'Make it more actionable'
]
const READ_PRESETS = ['Explain this', 'Summarize', 'Translate to English']

/**
 * Draws over other apps: highlights on the phrases a to-do came from, a soft
 * border around the window Polly is looking at, and the writing bubble next
 * to selected text.
 */
export function Overlay(): React.JSX.Element {
  const [origin, setOrigin] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 })
  const [highlights, setHighlights] = useState<{ rects: Rect[]; key: number } | null>(null)
  const [glow, setGlow] = useState<{ rect: Rect; key: number } | null>(null)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!bridge) return undefined
    const timers: ReturnType<typeof setTimeout>[] = []
    const off = bridge.onOverlay((payload) => {
      if (payload.origin) setOrigin(payload.origin)
      if (payload.highlights !== undefined) {
        const next = payload.highlights
        if (next) {
          const key = Date.now()
          setHighlights({ rects: next.rects, key })
          timers.push(setTimeout(() => setHighlights((h) => (h?.key === key ? null : h)), next.ms))
        } else setHighlights(null)
      }
      if (payload.glow !== undefined) {
        const next = payload.glow
        if (next) {
          const key = Date.now()
          setGlow({ rect: next.rect, key })
          timers.push(setTimeout(() => setGlow((g) => (g?.key === key ? null : g)), next.ms))
        } else setGlow(null)
      }
      if (payload.bubble !== undefined) {
        // Keep a bubble the user is working in, even if the selection moved.
        if (payload.bubble || !busyRef.current) setBubble(payload.bubble)
      }
    })
    return () => {
      off()
      timers.forEach(clearTimeout)
    }
  }, [])

  useEffect(() => {
    if (!highlights && !glow && !bubble) bridge?.overlayIdle()
  }, [highlights, glow, bubble])

  const local = (rect: Rect): React.CSSProperties => ({
    left: rect.x - origin.x,
    top: rect.y - origin.y,
    width: rect.width,
    height: rect.height
  })

  return (
    <>
      {glow && <div key={glow.key} className="glow" style={local(glow.rect)} />}
      {highlights?.rects.map((rect, i) => (
        <div key={`${highlights.key}-${i}`} className="mark" style={local(rect)} />
      ))}
      {bubble && (
        <WritingBubble
          key={`${bubble.selection.token}-${bubble.selection.text.length}`}
          bubble={bubble}
          origin={origin}
          onBusy={(busy) => {
            busyRef.current = busy
          }}
          onClose={() => {
            busyRef.current = false
            setBubble(null)
          }}
        />
      )}
    </>
  )
}

function WritingBubble({
  bubble,
  origin,
  onBusy,
  onClose
}: {
  bubble: Bubble
  origin: Rect
  onBusy: (busy: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const { selection, app } = bubble
  const editable = selection.editable
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState('')
  const [state, setState] = useState<'idle' | 'writing' | 'done' | 'replaced' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const control = useRef<AbortController | null>(null)

  const bounds = selection.bounds ?? { x: origin.x + 40, y: origin.y + 80, width: 0, height: 0 }
  // Above the selection when there is room, else below it.
  const width = open ? 400 : 34
  const above = bounds.y - origin.y > (open ? 300 : 48)
  const left = Math.min(
    Math.max(8, bounds.x - origin.x),
    origin.width - width - 8
  )
  const style: React.CSSProperties = above
    ? { left, bottom: origin.height - (bounds.y - origin.y) + 8 }
    : { left, top: bounds.y - origin.y + bounds.height + 8 }

  const report = useCallback(() => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    bridge?.setOverlayRect({ x: box.x, y: box.y, width: box.width, height: box.height })
  }, [])

  useLayoutEffect(() => {
    report()
    const el = ref.current
    if (!el) return undefined
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => {
      observer.disconnect()
      bridge?.setOverlayRect(null)
    }
  }, [report, open])

  useEffect(() => {
    const off = bridge?.onOverlayHover((inside) => {
      if (inside) setOpen(true)
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off?.()
      window.removeEventListener('keydown', onKey)
      control.current?.abort()
    }
  }, [onClose])

  const run = async (what: string): Promise<void> => {
    const text = what.trim()
    if (!text) return
    control.current?.abort()
    const abort = new AbortController()
    control.current = abort
    setLast(text)
    setResult('')
    setError(null)
    setState('writing')
    onBusy(true)
    try {
      await copilotApi.rewrite(
        { text: selection.text, instruction: text, token: selection.token, app: app.name },
        (event: CopilotEvent) => {
          if (event.type === 'card.delta') setResult((r) => r + event.text)
          else if (event.type === 'card.done') setResult(event.suggestion ?? event.text)
          else if (event.type === 'error') setError(event.message)
        },
        abort.signal
      )
      setState('done')
    } catch (err) {
      if (abort.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  const replace = async (): Promise<void> => {
    const res = await bridge?.write({
      token: selection.token,
      mode: 'replaceSelection',
      text: result
    })
    if (res) {
      setState('replaced')
      onBusy(false)
      setTimeout(onClose, 700)
    } else {
      setError("Couldn't put the text back; copy it instead.")
    }
  }

  if (!open) {
    return (
      <div ref={ref} className="bubble-dot" style={style} onClick={() => setOpen(true)}>
        <Sparkles size={15} />
      </div>
    )
  }

  const presets = editable ? EDIT_PRESETS : READ_PRESETS
  return (
    <div ref={ref} className="bubble" style={{ ...style, width }}>
      <div className="bubble-field">
        <Sparkles size={14} className="bubble-spark" />
        <input
          autoFocus
          value={instruction}
          placeholder={editable ? 'Ask Polly to change this…' : 'Ask about this…'}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run(instruction)
            }
          }}
        />
        <button
          className="bubble-send"
          disabled={!instruction.trim()}
          onClick={() => void run(instruction)}
          title="Go"
        >
          <ArrowUp size={14} />
        </button>
        <button className="bubble-icon" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      {state === 'idle' && (
        <div className="bubble-presets">
          {presets.map((preset) => (
            <button key={preset} onClick={() => void run(preset)}>
              {preset}
            </button>
          ))}
        </div>
      )}

      {state !== 'idle' && (
        <div className="bubble-result">
          {state === 'writing' && !result && (
            <div className="bubble-status">
              <Loader2 size={13} className="spin" /> Writing…
            </div>
          )}
          {result && <div className="bubble-text">{result}</div>}
          {error && <div className="bubble-error">{error}</div>}
          {(state === 'done' || state === 'replaced' || state === 'error') && (
            <div className="bubble-actions">
              {editable && result && (
                <button className="primary" disabled={state === 'replaced'} onClick={() => void replace()}>
                  {state === 'replaced' ? <Check size={13} /> : null}
                  {state === 'replaced' ? 'Replaced' : 'Replace'}
                </button>
              )}
              {result && (
                <button onClick={() => void bridge?.copy(result)}>
                  <Copy size={12} /> Copy
                </button>
              )}
              <button onClick={() => void run(last)}>
                <RotateCw size={12} /> Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
