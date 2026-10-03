import { ChevronDown, Minus, Plus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fromHsv, parseColor, toCss, toHex, toHsv, type HSV, type RGBA } from './color'
import { clamp } from './model'

/** The small controls the inspector is made of. */

export function Section({
  title,
  onAdd,
  onRemove,
  children
}: {
  title: string
  onAdd?: () => void
  onRemove?: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="dz-section">
      <header>
        <h4>{title}</h4>
        {onRemove && (
          <button className="dz-mini" title={`Remove ${title.toLowerCase()}`} onClick={onRemove}>
            <Minus />
          </button>
        )}
        {onAdd && (
          <button className="dz-mini" title={`Add ${title.toLowerCase()}`} onClick={onAdd}>
            <Plus />
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

export function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="dz-row">{children}</div>
}

/**
 * A number with a label you can drag to scrub. `onChange(value, commit)`:
 * scrubbing previews (`commit: false`) and commits once on release.
 */
export function Num({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit = '',
  placeholder = '–',
  title,
  disabled
}: {
  label: React.ReactNode
  value: number | null
  onChange: (value: number, commit: boolean) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  placeholder?: string
  title?: string
  disabled?: boolean
}): React.JSX.Element {
  const shown = value === null ? '' : String(Math.round(value * 100) / 100)
  const [draft, setDraft] = useState<string | null>(null)
  const scrub = useRef<{ x: number; value: number; moved: boolean } | null>(null)

  const apply = (text: string, commit: boolean): void => {
    const n = parseFloat(text)
    if (Number.isFinite(n)) onChange(clamp(n, min, max), commit)
  }

  return (
    <label className={`dz-num${disabled ? ' is-disabled' : ''}`} title={title}>
      <span
        className="dz-num-label"
        onPointerDown={(e) => {
          if (disabled) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub.current = { x: e.clientX, value: value ?? 0, moved: false }
        }}
        onPointerMove={(e) => {
          const s = scrub.current
          if (!s) return
          const delta = Math.round(e.clientX - s.x) * step * (e.shiftKey ? 10 : 1)
          if (delta !== 0) s.moved = true
          if (s.moved) onChange(clamp(s.value + delta, min, max), false)
        }}
        onPointerUp={(e) => {
          const s = scrub.current
          scrub.current = null
          if (s?.moved)
            onChange(clamp(s.value + Math.round(e.clientX - s.x) * step * (e.shiftKey ? 10 : 1), min, max), true)
        }}
      >
        {label}
      </span>
      <input
        value={draft ?? shown}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => {
          setDraft(shown)
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== shown) apply(draft, true)
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const next = clamp(
              (parseFloat(draft ?? shown) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1),
              min,
              max
            )
            setDraft(String(Math.round(next * 100) / 100))
            onChange(next, true)
          }
        }}
      />
      {unit && <em>{unit}</em>}
    </label>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  title
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  title?: string
}): React.JSX.Element {
  return (
    <label className="dz-select" title={title}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {!options.some((o) => o.value === value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown />
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T | null
  options: { value: T; icon?: React.ReactNode; label?: string; title: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="dz-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-active' : ''}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </div>
  )
}

export function IconToggle({
  active,
  title,
  onClick,
  disabled,
  children
}: {
  active?: boolean
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className={`dz-icon${active ? ' is-active' : ''}`}
      title={title}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const SWATCHES = ['#111111', '#ffffff', '#6b7280', '#ef4444', '#f59e0b', '#22c55e', '#0ea5e9', '#6366f1', '#ec4899']

/** A swatch, a hex box and an opacity; the swatch opens the picker. */
export function ColorField({
  value,
  onChange
}: {
  value: string
  onChange: (css: string, commit: boolean) => void
}): React.JSX.Element {
  const rgba = parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 }
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const hex = toHex(rgba).slice(1).toUpperCase()

  return (
    <div className="dz-color">
      <button
        ref={anchor}
        className="dz-swatch"
        title="Pick a colour"
        onClick={() => setOpen((o) => !o)}
      >
        <i style={{ background: toCss(rgba) }} />
      </button>
      <input
        className="dz-hex"
        value={draft ?? hex}
        spellCheck={false}
        onFocus={(e) => {
          setDraft(hex)
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parsed = draft ? parseColor(draft.startsWith('#') ? draft : `#${draft}`) ?? parseColor(draft) : null
          if (parsed && draft !== hex) onChange(toCss({ ...parsed, a: parsed.a < 1 ? parsed.a : rgba.a }), true)
          setDraft(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <Num
        label=""
        value={Math.round(rgba.a * 100)}
        min={0}
        max={100}
        unit="%"
        title="Opacity"
        onChange={(v, commit) => onChange(toCss({ ...rgba, a: v / 100 }), commit)}
      />
      {open && anchor.current && (
        <ColorPopover
          anchor={anchor.current}
          value={rgba}
          onChange={(c, commit) => onChange(toCss(c), commit)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function ColorPopover({
  anchor,
  value,
  onChange,
  onClose
}: {
  anchor: HTMLElement
  value: RGBA
  onChange: (color: RGBA, commit: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  // Hue and saturation are kept here: grey and black have none to read back.
  const [hsv, setHsv] = useState<HSV>(() => toHsv(value))
  const [alpha, setAlpha] = useState(value.a)
  const [pos, setPos] = useState({ left: -9999, top: 0 })

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect()
    const h = panel.current?.offsetHeight ?? 300
    setPos({
      left: Math.max(8, a.left - 248),
      top: clamp(a.top - 40, 8, window.innerHeight - h - 8)
    })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!panel.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])

  const emit = (next: HSV, a: number, commit: boolean): void => {
    setHsv(next)
    setAlpha(a)
    onChange(fromHsv(next, a), commit)
  }

  const track =
    (pick: (x: number, y: number) => [HSV, number]) =>
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      const at = (ev: { clientX: number; clientY: number }): [HSV, number] => {
        const r = el.getBoundingClientRect()
        return pick(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1))
      }
      emit(...at(e), false)
      const move = (ev: PointerEvent): void => emit(...at(ev), false)
      const up = (ev: PointerEvent): void => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        emit(...at(ev), true)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    }

  const solid = toHex(fromHsv({ h: hsv.h, s: 1, v: 1 }))
  const current = fromHsv(hsv, 1)

  return createPortal(
    <div ref={panel} className="dz-picker" style={pos}>
      <div
        className="dz-sv"
        style={{ background: solid }}
        onPointerDown={track((x, y) => [{ h: hsv.h, s: x, v: 1 - y }, alpha])}
      >
        <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: toHex(current) }} />
      </div>
      <div className="dz-hue" onPointerDown={track((x) => [{ ...hsv, h: x * 359.9 }, alpha])}>
        <i style={{ left: `${(hsv.h / 360) * 100}%`, background: solid }} />
      </div>
      <div
        className="dz-alpha"
        style={{ '--dz-solid': toHex(current) } as React.CSSProperties}
        onPointerDown={track((x) => [hsv, Math.round(x * 100) / 100])}
      >
        <i style={{ left: `${alpha * 100}%` }} />
      </div>
      <div className="dz-swatches">
        {SWATCHES.map((s) => (
          <button
            key={s}
            title={s}
            style={{ background: s }}
            onClick={() => {
              const c = parseColor(s) as RGBA
              emit(toHsv(c), 1, true)
            }}
          />
        ))}
      </div>
    </div>,
    document.body
  )
}
