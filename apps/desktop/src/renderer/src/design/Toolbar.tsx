import {
  Circle,
  Frame,
  Hand,
  ImagePlus,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  Square,
  Type,
  Undo2
} from 'lucide-react'
import { useRef } from 'react'
import type { Tool } from './model'
import { useCanvas } from './store'

const TOOLS: { id: Tool; label: string; key: string; icon: React.JSX.Element }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: <MousePointer2 /> },
  { id: 'hand', label: 'Pan', key: 'H', icon: <Hand /> },
  { id: 'frame', label: 'Frame', key: 'F', icon: <Frame /> },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <Square /> },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: <Circle /> },
  { id: 'text', label: 'Text', key: 'T', icon: <Type /> }
]

/** The floating bar under the canvas: tools, undo, zoom. */
export function Toolbar(): React.JSX.Element {
  const tool = useCanvas((s) => s.tool)
  const setTool = useCanvas((s) => s.setTool)
  const zoom = useCanvas((s) => s.view.zoom)
  const canUndo = useCanvas((s) => s.canUndo)
  const canRedo = useCanvas((s) => s.canRedo)
  const file = useRef<HTMLInputElement>(null)

  return (
    <div className="dz-toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={tool === t.id ? 'is-active' : ''}
          title={`${t.label} (${t.key})`}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
        </button>
      ))}
      <button title="Add an image" onClick={() => file.current?.click()}>
        <ImagePlus />
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length)
            window.dispatchEvent(new CustomEvent('polly:design-image', { detail: files }))
          e.target.value = ''
        }}
      />
      <i />
      <button title="Undo (⌘Z)" disabled={!canUndo} onClick={() => useCanvas.getState().undo()}>
        <Undo2 />
      </button>
      <button title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => useCanvas.getState().redo()}>
        <Redo2 />
      </button>
      <i />
      <button title="Zoom out (⌘−)" onClick={() => useCanvas.getState().zoomTo(zoom / 1.25)}>
        <Minus />
      </button>
      <button className="dz-zoom" title="Zoom to fit (⌘1)" onClick={() => useCanvas.getState().fit()}>
        {Math.round(zoom * 100)}%
      </button>
      <button title="Zoom in (⌘+)" onClick={() => useCanvas.getState().zoomTo(zoom * 1.25)}>
        <Plus />
      </button>
    </div>
  )
}
