import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowRight,
  Blend,
  Braces,
  Check,
  Code,
  Download,
  FileCode,
  ImagePlus,
  Italic,
  RotateCw,
  Scan,
  SquareDashed,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash2,
  Underline,
  WrapText
} from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api'
import {
  formatGradient,
  formatShadows,
  parseColor,
  parseGradient,
  parseShadows,
  toCss,
  type Gradient,
  type Shadow
} from './color'
import { capture, download, exportCode, fileName, type CodeFormat } from './exporters'
import { ColorField, IconToggle, Num, Row, Section, Segmented, Select } from './fields'
import { boxOf, isAbsolute, isContainer, rotationOf } from './frame'
import { FONTS, PRESETS, type Artboard, type NodeRef } from './model'
import { getFrame, useCanvas } from './store'

/**
 * The edit bar: everything about the selection you can change by hand.
 * Values are read from the live DOM's computed style, and edits are written
 * as inline styles, which win over the Tailwind classes the agent wrote.
 */

type Style = Record<string, string | null>
const px = (v: string): number => parseFloat(v) || 0
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']
const WEIGHT_NAMES = ['Thin', 'Extra light', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Extra bold', 'Black']

function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

/** Whether the edit panel has anything to show: a selection, or frame sizes to pick. */
export function useInspecting(): boolean {
  const selection = useCanvas((s) => s.selection)
  const tool = useCanvas((s) => s.tool)
  return tool === 'frame' || selection.length > 0
}

export function Inspector(): React.JSX.Element | null {
  const selection = useCanvas((s) => s.selection)
  const doc = useCanvas((s) => s.doc)
  const tool = useCanvas((s) => s.tool)
  useCanvas((s) => s.version)
  const frame = getFrame()

  if (tool === 'frame') return <FramePresets />
  const first = selection[0]
  if (!frame || !first) return null

  const board = doc.artboards.find((b) => b.id === first.boardId)
  if (!board) return null
  if (first.nodeId === null) return <BoardInspector board={board} />

  const nodes = selection
    .filter((r) => r.nodeId !== null)
    .map((r) => frame.node(r))
    .filter((n): n is HTMLElement => !!n)
  const el = nodes[0]
  if (!el) return null

  return <NodeInspector key={first.nodeId} el={el} nodes={nodes} refTo={first} board={board} />
}

function NodeInspector({
  el,
  nodes,
  refTo,
  board
}: {
  el: HTMLElement
  nodes: HTMLElement[]
  refTo: NodeRef
  board: Artboard
}): React.JSX.Element {
  const store = useCanvas.getState()
  const fonts = useCanvas((s) => s.doc.fonts)
  const [corners, setCorners] = useState(false)
  const [sides, setSides] = useState(false)
  const view = el.ownerDocument.defaultView as Window
  const cs = view.getComputedStyle(el)
  const parent = el.parentElement as HTMLElement
  const set = (props: Style, commit = true): void => store.setStyle(props, commit)
  const one =
    (prop: string, unit = 'px') =>
    (v: number, commit: boolean): void =>
      set({ [prop]: `${v}${unit}` }, commit)

  const absolute = isAbsolute(el)
  // A layer on the open canvas has no frame to line up with on its own.
  const looseTop = parent.classList.contains('pl-root') && !!parent.parentElement?.classList.contains('is-loose')
  const allAbsolute = nodes.every(isAbsolute)
  const alignable = allAbsolute && (nodes.length > 1 || !looseTop)
  const tag = el.localName
  const isImage = tag === 'img'
  const isSvg = tag === 'svg'
  const hasText = !!el.textContent?.trim() && !isSvg
  const container = isContainer(el) && !isImage
  const flex = cs.display.includes('flex')
  const row = cs.flexDirection.startsWith('row')

  // ---------- align ----------

  const align = (kind: 'l' | 'h' | 'r' | 't' | 'v' | 'b'): void => {
    const items = nodes.filter(isAbsolute)
    if (items.length === 0) return
    const boxes = items.map(boxOf)
    // One layer aligns to its frame (or group); several align to each other.
    if (items.length === 1 && looseTop) return
    const area =
      items.length === 1
        ? { l: 0, t: 0, r: parent.clientWidth, b: parent.clientHeight }
        : {
            l: Math.min(...boxes.map((b) => b.left)),
            t: Math.min(...boxes.map((b) => b.top)),
            r: Math.max(...boxes.map((b) => b.left + b.width)),
            b: Math.max(...boxes.map((b) => b.top + b.height))
          }
    items.forEach((n, i) => {
      const { width: w, height: h } = boxes[i]
      if (kind === 'l') n.style.left = `${area.l}px`
      if (kind === 'h') n.style.left = `${Math.round((area.l + area.r - w) / 2)}px`
      if (kind === 'r') n.style.left = `${area.r - w}px`
      if (kind === 't') n.style.top = `${area.t}px`
      if (kind === 'v') n.style.top = `${Math.round((area.t + area.b - h) / 2)}px`
      if (kind === 'b') n.style.top = `${area.b - h}px`
      if ('lhr'.includes(kind)) n.style.right = 'auto'
      else n.style.bottom = 'auto'
    })
    store.commit()
  }

  const distribute = (axis: 'x' | 'y'): void => {
    const items = nodes.filter(isAbsolute)
    if (items.length < 3) return
    const start = (n: HTMLElement): number => (axis === 'x' ? boxOf(n).left : boxOf(n).top)
    const size = (n: HTMLElement): number => (axis === 'x' ? boxOf(n).width : boxOf(n).height)
    const sorted = [...items].sort((a, b) => start(a) - start(b))
    const last = sorted[sorted.length - 1]
    const free = start(last) + size(last) - start(sorted[0]) - sorted.reduce((sum, n) => sum + size(n), 0)
    const gap = free / (sorted.length - 1)
    let at = start(sorted[0])
    for (const n of sorted) {
      if (axis === 'x') n.style.left = `${Math.round(at)}px`
      else n.style.top = `${Math.round(at)}px`
      at += size(n) + gap
    }
    store.commit()
  }

  // ---------- position ----------

  const setPositioning = (mode: 'auto' | 'absolute'): void => {
    for (const n of nodes) {
      if (mode === 'absolute' && !isAbsolute(n)) {
        const host = n.parentElement as HTMLElement
        const box = boxOf(n)
        const left = box.left - (n.offsetParent === host || !('offsetWidth' in n) ? 0 : host.offsetLeft)
        const top = box.top - (n.offsetParent === host || !('offsetWidth' in n) ? 0 : host.offsetTop)
        const { width: w, height: h } = box
        if (view.getComputedStyle(host).position === 'static') host.style.position = 'relative'
        Object.assign(n.style, {
          position: 'absolute',
          left: `${left}px`,
          top: `${top}px`,
          width: `${w}px`,
          height: `${h}px`
        })
      } else if (mode === 'auto' && isAbsolute(n)) {
        for (const prop of ['position', 'left', 'top', 'right', 'bottom']) n.style.removeProperty(prop)
        if (isAbsolute(n)) n.style.position = 'relative'
      }
    }
    store.commit()
  }

  const sizing = (axis: 'width' | 'height'): 'fixed' | 'fill' | 'hug' => {
    const v = el.style.getPropertyValue(axis)
    return v === '100%' ? 'fill' : v === 'fit-content' || v === 'auto' ? 'hug' : 'fixed'
  }
  const setSizing = (axis: 'width' | 'height', mode: 'fixed' | 'fill' | 'hug'): void => {
    const now = axis === 'width' ? boxOf(el).width : boxOf(el).height
    set({ [axis]: mode === 'fill' ? '100%' : mode === 'hug' ? 'fit-content' : `${now}px` })
  }
  const SIZING = [
    { value: 'fixed' as const, label: 'Fixed' },
    { value: 'fill' as const, label: 'Fill' },
    { value: 'hug' as const, label: 'Hug' }
  ]

  // ---------- layout ----------

  const jc = cs.justifyContent
  const ai = cs.alignItems
  const main = jc.includes('center') ? 1 : jc.includes('end') ? 2 : 0
  const cross = ai.includes('center') ? 1 : ai.includes('end') ? 2 : 0
  const between = jc === 'space-between'
  const KEY = ['flex-start', 'center', 'flex-end']
  const setAlign = (col: number, rowIndex: number): void =>
    set({
      'justify-content': between ? 'space-between' : KEY[row ? col : rowIndex],
      'align-items': KEY[row ? rowIndex : col]
    })

  // ---------- fill ----------

  const bgImage = cs.backgroundImage
  const gradient = parseGradient(bgImage)
  const bgColor = parseColor(cs.backgroundColor)
  const imageFill = bgImage.startsWith('url(')
  const fill: 'none' | 'solid' | 'linear' | 'radial' | 'image' = gradient
    ? gradient.kind
    : imageFill
      ? 'image'
      : bgColor && bgColor.a > 0
        ? 'solid'
        : 'none'
  const solid = bgColor && bgColor.a > 0 ? toCss(bgColor) : '#d9d9d9'

  const upload = async (): Promise<string | null> => {
    const file = await pickImage()
    const sessionId = file ? await useCanvas.getState().ensureSession() : null
    if (!file || !sessionId) return null
    const res = await api.design.upload(sessionId, file, file.name)
    return res.ok ? res.data.url : null
  }

  const setFill = async (kind: typeof fill): Promise<void> => {
    if (kind === 'none') set({ 'background-color': 'transparent', 'background-image': 'none' })
    else if (kind === 'solid') set({ 'background-color': solid, 'background-image': 'none' })
    else if (kind === 'image') {
      const url = await upload()
      if (url)
        set({
          'background-image': `url("${url}")`,
          'background-size': 'cover',
          'background-position': 'center',
          'background-repeat': 'no-repeat'
        })
    } else {
      const base: Gradient = gradient ?? {
        kind,
        angle: 135,
        stops: [
          { color: solid, at: 0 },
          { color: '#111111', at: 100 }
        ]
      }
      set({ 'background-image': formatGradient({ ...base, kind }) })
    }
  }
  const setGradient = (g: Gradient, commit: boolean): void =>
    set({ 'background-image': formatGradient(g) }, commit)

  // ---------- stroke, shadow, effects ----------

  const borderWidth = px(cs.borderTopWidth)
  const hasStroke = borderWidth > 0 && cs.borderTopStyle !== 'none'
  const shadows = parseShadows(cs.boxShadow).filter(
    (s) => s.x || s.y || s.blur || s.spread || (parseColor(s.color)?.a ?? 0) > 0.001
  ).filter((s) => (parseColor(s.color)?.a ?? 1) > 0.001)
  const setShadows = (next: Shadow[], commit: boolean): void =>
    set({ 'box-shadow': next.length ? formatShadows(next) : 'none' }, commit)
  const blur = px(cs.filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? '0')
  const backdrop = px(cs.backdropFilter?.match(/blur\(([\d.]+)px\)/)?.[1] ?? '0')

  const radius = [
    px(cs.borderTopLeftRadius),
    px(cs.borderTopRightRadius),
    px(cs.borderBottomRightRadius),
    px(cs.borderBottomLeftRadius)
  ]
  const uniform = radius.every((r) => r === radius[0])
  const pad = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)]

  const family = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim()
  const families = Array.from(new Set([...fonts, ...FONTS])).map((f) => ({ value: f, label: f }))
  const textAlign = cs.textAlign === 'start' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign

  const kind = nodes.length > 1 ? 'Selection' : kindOf(el)
  return (
    <div className="dz-inspector">
      <div className="dz-insp-head">
        <b>{nodes.length > 1 ? `${nodes.length} layers` : (el.getAttribute('data-name') ?? labelOf(el))}</b>
        <span>{kind}</span>
      </div>

      <div className="dz-align">
        <IconToggle title="Align left" disabled={!alignable} onClick={() => align('l')}>
          <AlignStartVertical />
        </IconToggle>
        <IconToggle title="Align horizontal centres" disabled={!alignable} onClick={() => align('h')}>
          <AlignCenterVertical />
        </IconToggle>
        <IconToggle title="Align right" disabled={!alignable} onClick={() => align('r')}>
          <AlignEndVertical />
        </IconToggle>
        <IconToggle title="Align top" disabled={!alignable} onClick={() => align('t')}>
          <AlignStartHorizontal />
        </IconToggle>
        <IconToggle title="Align vertical centres" disabled={!alignable} onClick={() => align('v')}>
          <AlignCenterHorizontal />
        </IconToggle>
        <IconToggle title="Align bottom" disabled={!alignable} onClick={() => align('b')}>
          <AlignEndHorizontal />
        </IconToggle>
        <IconToggle
          title="Distribute horizontally"
          disabled={!allAbsolute || nodes.length < 3}
          onClick={() => distribute('x')}
        >
          <AlignHorizontalDistributeCenter />
        </IconToggle>
        <IconToggle
          title="Distribute vertically"
          disabled={!allAbsolute || nodes.length < 3}
          onClick={() => distribute('y')}
        >
          <AlignVerticalDistributeCenter />
        </IconToggle>
      </div>

      <Section title="Position">
        <Segmented
          value={absolute ? 'absolute' : 'auto'}
          options={[
            { value: 'auto', label: 'In layout', title: 'Placed by its parent’s layout' },
            { value: 'absolute', label: 'Free', title: 'Placed freely with X and Y' }
          ]}
          onChange={setPositioning}
        />
        <Row>
          <Num
            label="X"
            value={absolute ? (cs.left === 'auto' ? boxOf(el).left : px(cs.left)) : null}
            disabled={!absolute}
            onChange={(v, c) => set({ left: `${v}px`, right: 'auto' }, c)}
          />
          <Num
            label="Y"
            value={absolute ? (cs.top === 'auto' ? boxOf(el).top : px(cs.top)) : null}
            disabled={!absolute}
            onChange={(v, c) => set({ top: `${v}px`, bottom: 'auto' }, c)}
          />
        </Row>
        <Row>
          <Num label="W" value={boxOf(el).width} min={0} onChange={one('width')} />
          <Num label="H" value={boxOf(el).height} min={0} onChange={one('height')} />
        </Row>
        {!isSvg && (
          <Row>
            <Select title="Width" value={sizing('width')} options={SIZING} onChange={(m) => setSizing('width', m)} />
            <Select title="Height" value={sizing('height')} options={SIZING} onChange={(m) => setSizing('height', m)} />
          </Row>
        )}
        <Row>
          <Num
            label={<RotateCw />}
            title="Rotation"
            value={Math.round(rotationOf(el) * 10) / 10}
            unit="°"
            onChange={(v, c) => set({ rotate: `${v}deg` }, c)}
          />
          <Num
            label={<Blend />}
            title="Opacity"
            value={Math.round(parseFloat(cs.opacity) * 100)}
            min={0}
            max={100}
            unit="%"
            onChange={(v, c) => set({ opacity: String(v / 100) }, c)}
          />
        </Row>
      </Section>

      {container && (
        <Section
          title="Auto layout"
          onAdd={flex ? undefined : () => set({ display: 'flex', 'flex-direction': 'column', gap: '8px' })}
          onRemove={flex ? () => set({ display: 'block' }) : undefined}
        >
          {flex && (
            <>
              <Row>
                <Segmented
                  value={cs.flexWrap === 'wrap' ? 'wrap' : row ? 'row' : 'column'}
                  options={[
                    { value: 'row', icon: <ArrowRight />, title: 'Horizontal' },
                    { value: 'column', icon: <ArrowDown />, title: 'Vertical' },
                    { value: 'wrap', icon: <WrapText />, title: 'Wrap' }
                  ]}
                  onChange={(v) =>
                    set(
                      v === 'wrap'
                        ? { 'flex-direction': 'row', 'flex-wrap': 'wrap' }
                        : { 'flex-direction': v, 'flex-wrap': 'nowrap' }
                    )
                  }
                />
                <Num
                  label="Gap"
                  value={between ? null : px(cs.columnGap === 'normal' ? '0' : row ? cs.columnGap : cs.rowGap)}
                  placeholder="Auto"
                  min={0}
                  onChange={one('gap')}
                />
              </Row>
              <Row>
                <div className="dz-align-grid" title="Align children">
                  {[0, 1, 2].map((r) =>
                    [0, 1, 2].map((c) => {
                      const active = (row ? main : cross) === c && (row ? cross : main) === r
                      return (
                        <button
                          key={`${r}${c}`}
                          className={active ? 'is-active' : ''}
                          onClick={() => setAlign(c, r)}
                        />
                      )
                    })
                  )}
                </div>
                <div className="dz-stack">
                  <IconToggle
                    active={between}
                    title="Space between"
                    onClick={() => set({ 'justify-content': between ? KEY[main] : 'space-between' })}
                  >
                    <AlignHorizontalSpaceBetween />
                  </IconToggle>
                  <IconToggle
                    active={cs.overflow === 'hidden'}
                    title="Clip content"
                    onClick={() => set({ overflow: cs.overflow === 'hidden' ? 'visible' : 'hidden' })}
                  >
                    <SquareDashed />
                  </IconToggle>
                </div>
              </Row>
            </>
          )}
          <Row>
            {sides ? (
              <>
                <Num label="T" value={pad[0]} min={0} onChange={one('padding-top')} />
                <Num label="R" value={pad[1]} min={0} onChange={one('padding-right')} />
              </>
            ) : (
              <>
                <Num
                  label="↔"
                  title="Horizontal padding"
                  value={pad[1] === pad[3] ? pad[1] : null}
                  placeholder="Mixed"
                  min={0}
                  onChange={(v, c) => set({ 'padding-left': `${v}px`, 'padding-right': `${v}px` }, c)}
                />
                <Num
                  label="↕"
                  title="Vertical padding"
                  value={pad[0] === pad[2] ? pad[0] : null}
                  placeholder="Mixed"
                  min={0}
                  onChange={(v, c) => set({ 'padding-top': `${v}px`, 'padding-bottom': `${v}px` }, c)}
                />
              </>
            )}
            <IconToggle active={sides} title="Padding per side" onClick={() => setSides(!sides)}>
              <SquareDashed />
            </IconToggle>
          </Row>
          {sides && (
            <Row>
              <Num label="B" value={pad[2]} min={0} onChange={one('padding-bottom')} />
              <Num label="L" value={pad[3]} min={0} onChange={one('padding-left')} />
              <span className="dz-icon-space" />
            </Row>
          )}
        </Section>
      )}

      {hasText && (
        <Section title="Text">
          <Select
            value={family}
            options={families}
            onChange={(f) => {
              store.useFont(f)
              set({ 'font-family': `'${f}', sans-serif` })
            }}
          />
          <Row>
            <Select
              value={cs.fontWeight}
              options={WEIGHTS.map((w, i) => ({ value: w, label: WEIGHT_NAMES[i] }))}
              onChange={(w) => set({ 'font-weight': w })}
            />
            <Num label="Size" value={px(cs.fontSize)} min={1} onChange={one('font-size')} />
          </Row>
          <Row>
            <Num
              label="Line"
              title="Line height"
              value={cs.lineHeight === 'normal' ? null : px(cs.lineHeight)}
              placeholder="Auto"
              min={0}
              onChange={one('line-height')}
            />
            <Num
              label="Letter"
              title="Letter spacing"
              value={cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing)}
              step={0.1}
              onChange={one('letter-spacing')}
            />
          </Row>
          <Row>
            <Segmented
              value={textAlign as 'left'}
              options={[
                { value: 'left', icon: <TextAlignStart />, title: 'Align left' },
                { value: 'center', icon: <TextAlignCenter />, title: 'Align centre' },
                { value: 'right', icon: <TextAlignEnd />, title: 'Align right' },
                { value: 'justify', icon: <TextAlignJustify />, title: 'Justify' }
              ]}
              onChange={(v) => set({ 'text-align': v })}
            />
            <IconToggle
              active={cs.fontStyle === 'italic'}
              title="Italic"
              onClick={() => set({ 'font-style': cs.fontStyle === 'italic' ? 'normal' : 'italic' })}
            >
              <Italic />
            </IconToggle>
            <IconToggle
              active={cs.textDecorationLine.includes('underline')}
              title="Underline"
              onClick={() =>
                set({
                  'text-decoration-line': cs.textDecorationLine.includes('underline') ? 'none' : 'underline'
                })
              }
            >
              <Underline />
            </IconToggle>
          </Row>
          <ColorField value={cs.color} onChange={(v, c) => set({ color: v }, c)} />
        </Section>
      )}

      {isImage && (
        <Section title="Image">
          <Row>
            <button
              className="dz-btn"
              onClick={() =>
                void upload().then((url) => {
                  if (!url) return
                  el.setAttribute('src', url)
                  store.commit()
                })
              }
            >
              <ImagePlus /> Replace
            </button>
            <Select
              title="How the image fits its box"
              value={cs.objectFit as 'cover'}
              options={[
                { value: 'cover', label: 'Fill' },
                { value: 'contain', label: 'Fit' },
                { value: 'fill', label: 'Stretch' }
              ]}
              onChange={(v) => set({ 'object-fit': v })}
            />
          </Row>
        </Section>
      )}

      {!isImage && !isSvg && (
        <Section title="Fill">
          <Select
            value={fill}
            options={[
              { value: 'none', label: 'None' },
              { value: 'solid', label: 'Solid' },
              { value: 'linear', label: 'Linear gradient' },
              { value: 'radial', label: 'Radial gradient' },
              { value: 'image', label: 'Image' }
            ]}
            onChange={(k) => void setFill(k)}
          />
          {fill === 'solid' && (
            <ColorField
              value={solid}
              onChange={(v, c) => set({ 'background-color': v, 'background-image': 'none' }, c)}
            />
          )}
          {gradient && <GradientEditor gradient={gradient} onChange={setGradient} />}
          {fill === 'image' && (
            <Row>
              <button className="dz-btn" onClick={() => void setFill('image')}>
                <ImagePlus /> Replace
              </button>
              <Select
                value={cs.backgroundSize === 'contain' ? 'contain' : 'cover'}
                options={[
                  { value: 'cover', label: 'Fill' },
                  { value: 'contain', label: 'Fit' }
                ]}
                onChange={(v) => set({ 'background-size': v })}
              />
            </Row>
          )}
        </Section>
      )}

      {isSvg && (
        <Section title="Stroke">
          <ColorField value={cs.color} onChange={(v, c) => set({ color: v }, c)} />
          <Row>
            <Num
              label="Weight"
              title="Stroke weight"
              value={px(cs.strokeWidth) || px(el.getAttribute('stroke-width') ?? '') || 0}
              min={0}
              step={0.25}
              onChange={(v, c) => set({ 'stroke-width': `${v}px` }, c)}
            />
            <span className="dz-row-gap" />
          </Row>
        </Section>
      )}

      {!isSvg && (
        <Section
          title="Stroke"
          onAdd={hasStroke ? undefined : () => set({ border: '1px solid #111111' })}
          onRemove={hasStroke ? () => set({ border: 'none' }) : undefined}
        >
          {hasStroke && (
            <>
              <ColorField value={cs.borderTopColor} onChange={(v, c) => set({ 'border-color': v }, c)} />
              <Row>
                <Num label="Width" value={borderWidth} min={0} onChange={one('border-width')} />
                <Select
                  value={cs.borderTopStyle as 'solid'}
                  options={[
                    { value: 'solid', label: 'Solid' },
                    { value: 'dashed', label: 'Dashed' },
                    { value: 'dotted', label: 'Dotted' }
                  ]}
                  onChange={(v) => set({ 'border-style': v })}
                />
              </Row>
            </>
          )}
        </Section>
      )}

      {!isSvg && (
        <Section title="Corners">
          <Row>
            {corners ? (
              <>
                <Num label="↖" value={radius[0]} min={0} onChange={one('border-top-left-radius')} />
                <Num label="↗" value={radius[1]} min={0} onChange={one('border-top-right-radius')} />
              </>
            ) : (
              <Num
                label={<Scan />}
                title="Corner radius"
                value={uniform ? radius[0] : null}
                placeholder="Mixed"
                min={0}
                onChange={one('border-radius')}
              />
            )}
            <IconToggle active={corners} title="Radius per corner" onClick={() => setCorners(!corners)}>
              <Scan />
            </IconToggle>
          </Row>
          {corners && (
            <Row>
              <Num label="↙" value={radius[3]} min={0} onChange={one('border-bottom-left-radius')} />
              <Num label="↘" value={radius[2]} min={0} onChange={one('border-bottom-right-radius')} />
              <span className="dz-icon-space" />
            </Row>
          )}
        </Section>
      )}

      {!isSvg && (
        <Section
          title="Shadow"
          onAdd={() =>
            setShadows(
              [...shadows, { x: 0, y: 8, blur: 24, spread: 0, color: 'rgba(0, 0, 0, 0.16)', inset: false }],
              true
            )
          }
        >
          {shadows.map((shadow, i) => {
            const change = (patch: Partial<Shadow>, commit: boolean): void =>
              setShadows(
                shadows.map((s, n) => (n === i ? { ...s, ...patch } : s)),
                commit
              )
            return (
              <div className="dz-shadow" key={i}>
                <Row>
                  <Num label="X" value={shadow.x} onChange={(v, c) => change({ x: v }, c)} />
                  <Num label="Y" value={shadow.y} onChange={(v, c) => change({ y: v }, c)} />
                  <IconToggle
                    title="Remove shadow"
                    onClick={() =>
                      setShadows(
                        shadows.filter((_, n) => n !== i),
                        true
                      )
                    }
                  >
                    <Trash2 />
                  </IconToggle>
                </Row>
                <Row>
                  <Num label="Blur" value={shadow.blur} min={0} onChange={(v, c) => change({ blur: v }, c)} />
                  <Num label="Spread" value={shadow.spread} onChange={(v, c) => change({ spread: v }, c)} />
                  <IconToggle
                    active={shadow.inset}
                    title="Inner shadow"
                    onClick={() => change({ inset: !shadow.inset }, true)}
                  >
                    <SquareDashed />
                  </IconToggle>
                </Row>
                <ColorField value={shadow.color} onChange={(v, c) => change({ color: v }, c)} />
              </div>
            )
          })}
        </Section>
      )}

      <Section title="Blur">
        <Row>
          <Num
            label="Layer"
            title="Blur this layer"
            value={blur}
            min={0}
            onChange={(v, c) => set({ filter: v ? `blur(${v}px)` : 'none' }, c)}
          />
          <Num
            label="Behind"
            title="Blur what is behind this layer (needs a see-through fill)"
            value={backdrop}
            min={0}
            onChange={(v, c) => set({ 'backdrop-filter': v ? `blur(${v}px)` : 'none' }, c)}
          />
        </Row>
      </Section>

      <ExportSection board={board} nodeId={refTo.nodeId} />
    </div>
  )
}

/** What kind of layer it is, in a word, for the panel's header. */
function kindOf(el: Element): string {
  const name = el.getAttribute('data-name')
  if (name === 'Line' || name === 'Arrow') return 'Line'
  if (el.localName === 'img') return 'Image'
  if (el.localName === 'svg') return 'Vector'
  if (el.children.length === 0 && el.textContent?.trim()) return 'Text'
  if (el.children.length === 0) return 'Shape'
  return 'Group'
}

function labelOf(el: Element): string {
  const text = el.children.length === 0 ? el.textContent?.trim() : ''
  if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text
  const names: Record<string, string> = { img: 'Image', svg: 'Icon', button: 'Button', input: 'Input' }
  return names[el.localName] ?? 'Layer'
}

function GradientEditor({
  gradient,
  onChange
}: {
  gradient: Gradient
  onChange: (g: Gradient, commit: boolean) => void
}): React.JSX.Element {
  const stop = (i: number, patch: Partial<Gradient['stops'][number]>, commit: boolean): void =>
    onChange({ ...gradient, stops: gradient.stops.map((s, n) => (n === i ? { ...s, ...patch } : s)) }, commit)
  return (
    <div className="dz-gradient">
      <div className="dz-gradient-bar" style={{ background: formatGradient({ ...gradient, kind: 'linear', angle: 90 }) }} />
      {gradient.kind === 'linear' && (
        <Row>
          <Num
            label="Angle"
            value={gradient.angle}
            unit="°"
            onChange={(v, c) => onChange({ ...gradient, angle: ((v % 360) + 360) % 360 }, c)}
          />
          <button
            className="dz-btn"
            onClick={() =>
              onChange(
                { ...gradient, stops: [...gradient.stops, { color: gradient.stops[gradient.stops.length - 1].color, at: 100 }] },
                true
              )
            }
          >
            Add stop
          </button>
        </Row>
      )}
      {gradient.stops.map((s, i) => (
        <div className="dz-stop" key={i}>
          <ColorField value={s.color} onChange={(v, c) => stop(i, { color: v }, c)} />
          <Num label="" title="Position" value={s.at} min={0} max={100} unit="%" onChange={(v, c) => stop(i, { at: v }, c)} />
          <IconToggle
            title="Remove stop"
            disabled={gradient.stops.length <= 2}
            onClick={() => onChange({ ...gradient, stops: gradient.stops.filter((_, n) => n !== i) }, true)}
          >
            <Trash2 />
          </IconToggle>
        </div>
      ))}
    </div>
  )
}

function BoardInspector({ board }: { board: Artboard }): React.JSX.Element {
  const update = useCanvas((s) => s.updateBoard)
  const preset = PRESETS.find((p) => p.width === board.width && p.height === board.height)
  return (
    <div className="dz-inspector">
      <div className="dz-insp-head">
        <b>{board.name}</b>
        <span>Frame</span>
      </div>
      <Section title="Frame">
        <input
          className="dz-text"
          key={board.id + board.name}
          defaultValue={board.name}
          onBlur={(e) => update(board.id, { name: e.target.value.trim() || board.name })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <Select
          value={preset?.name ?? 'Custom'}
          options={PRESETS.map((p) => ({ value: p.name, label: `${p.name}  ${p.width}×${p.height}` }))}
          onChange={(name) => {
            const p = PRESETS.find((x) => x.name === name)
            if (p) update(board.id, { width: p.width, height: p.height })
          }}
        />
        <Row>
          <Num label="W" value={board.width} min={16} onChange={(v, c) => update(board.id, { width: v }, c)} />
          <Num label="H" value={board.height} min={16} onChange={(v, c) => update(board.id, { height: v }, c)} />
        </Row>
        <Row>
          <Num label="X" value={board.x} onChange={(v, c) => update(board.id, { x: v }, c)} />
          <Num label="Y" value={board.y} onChange={(v, c) => update(board.id, { y: v }, c)} />
        </Row>
      </Section>
      <Section title="Background">
        <ColorField value={board.background} onChange={(v, c) => update(board.id, { background: v }, c)} />
      </Section>
      <ExportSection board={board} nodeId={null} />
    </div>
  )
}

function ExportSection({ board, nodeId }: { board: Artboard; nodeId: string | null }): React.JSX.Element {
  const [done, setDone] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const name = fileName(board.name)

  const flash = (key: string): void => {
    setDone(key)
    setFailed(null)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(null), 1600)
  }

  const code = async (format: CodeFormat): Promise<void> => {
    const frame = getFrame()
    if (!frame) return
    const text = await exportCode(frame, board, nodeId, format, useCanvas.getState().doc.fonts)
    try {
      await navigator.clipboard.writeText(text)
      flash(format)
    } catch {
      download(`${name}.${format === 'jsx' ? 'jsx' : 'html'}`, text)
      flash(format)
    }
  }

  const image = async (format: 'png' | 'svg'): Promise<void> => {
    const frame = getFrame()
    const el = nodeId ? frame?.node({ boardId: board.id, nodeId }) : frame?.root(board.id)
    if (!el) return
    try {
      download(`${name}.${format}`, await capture(el, format))
      flash(format)
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The image could not be made.')
    }
  }

  const saveHtml = async (): Promise<void> => {
    const frame = getFrame()
    if (!frame) return
    download(
      `${name}.html`,
      await exportCode(frame, board, nodeId, 'html', useCanvas.getState().doc.fonts),
      'text/html'
    )
    flash('file')
  }

  const Btn = ({ id, icon, label, run }: { id: string; icon: React.ReactNode; label: string; run: () => void }): React.JSX.Element => (
    <button className="dz-btn" onClick={run}>
      {done === id ? <Check /> : icon} {label}
    </button>
  )

  return (
    <Section title={nodeId ? 'Export layer' : 'Export frame'}>
      <div className="dz-export">
        <Btn id="tailwind" icon={<Code />} label="Copy HTML + Tailwind" run={() => void code('tailwind')} />
        <Btn id="jsx" icon={<Braces />} label="Copy React" run={() => void code('jsx')} />
        <Btn id="html" icon={<FileCode />} label="Copy HTML" run={() => void code('html')} />
        <Btn id="file" icon={<Download />} label="Save .html" run={() => void saveHtml()} />
        <Btn id="png" icon={<Download />} label="PNG" run={() => void image('png')} />
        <Btn id="svg" icon={<Download />} label="SVG" run={() => void image('svg')} />
      </div>
      {failed && <p className="dz-note is-error">{failed}</p>}
    </Section>
  )
}

/** While the Frame tool is on: the standard sizes, a click away. */
function FramePresets(): React.JSX.Element {
  const groups = Array.from(new Set(PRESETS.map((p) => p.group)))
  const add = (p: (typeof PRESETS)[number]): void => {
    const store = useCanvas.getState()
    const board = store.addBoard({ name: p.name, width: p.width, height: p.height })
    store.setTool('select')
    store.fit(board.id)
  }
  return (
    <div className="dz-inspector">
      <div className="dz-insp-head">
        <b>Frame</b>
        <span>Drag on the canvas, or pick a size</span>
      </div>
      {groups.map((group) => (
        <Section key={group} title={group}>
          <div className="dz-presets">
            {PRESETS.filter((p) => p.group === group).map((p) => (
              <button key={p.name} onClick={() => add(p)}>
                <span>{p.name}</span>
                <em>
                  {p.width} × {p.height}
                </em>
              </button>
            ))}
          </div>
        </Section>
      ))}
    </div>
  )
}
