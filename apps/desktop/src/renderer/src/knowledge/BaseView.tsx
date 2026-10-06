import { ChevronLeft, CircleAlert, Ellipsis, Eraser, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeDetail, KnowledgeFile } from '../../../shared/contracts'
import { api } from '../api'
import { Popover } from '../coder/Composer'
import { BaseDialog } from './BaseDialog'
import { KnowledgeChat } from './Chat'
import { useKnowledgeChat } from './store'
import { FilesPane } from './Files'
import { formatSize, plural } from './format'

/** How often to look in on files that are still being read. */
const POLL_MS = 2000
/** The largest file the server takes. */
const MAX_BYTES = 50 * 1024 * 1024

const carriesFiles = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes('Files')

interface Props {
  id: string
  onBack: () => void
  onDeleted: () => void
}

/** One knowledge base: its files beside a conversation about them. */
export function BaseView({ id, onBack, onDeleted }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const depth = useRef(0)
  const talked = useKnowledgeChat((s) => (s.threads[id]?.length ?? 0) > 0)
  const clearChat = useKnowledgeChat((s) => s.clear)

  const load = useCallback(async () => {
    const res = await api.knowledge.get(id)
    if (res.ok) {
      setDetail(res.data)
      setError(null)
    } else setError(res.error)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const processing = detail?.files.filter((f) => f.status === 'processing').length ?? 0
  useEffect(() => {
    if (processing === 0) return
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [processing, load])

  const upload = async (picked: File[]): Promise<void> => {
    // The server takes files up to 50 MB; say so here rather than after the upload.
    const files = picked.filter((f) => f.size <= MAX_BYTES)
    const big = picked.filter((f) => f.size > MAX_BYTES)
    setProblem(
      big.length === 0
        ? null
        : `${big.length === 1 ? big[0].name : plural(big.length, 'file')} ${big.length === 1 ? 'is' : 'are'} over 50 MB, the most a file can be.`
    )
    if (files.length === 0) return
    const names = files.map((f) => f.name)
    setUploading((u) => [...u, ...names])
    const res = await api.knowledge.upload(id, files)
    setUploading((u) => {
      const left = [...u]
      for (const name of names) left.splice(left.indexOf(name), 1)
      return left
    })
    if (res.ok) {
      const added = new Set(res.data.map((f) => f.id))
      setDetail(
        (d) => d && { ...d, files: [...res.data, ...d.files.filter((f) => !added.has(f.id))] }
      )
    } else setProblem(/\b413\b/.test(res.error) ? 'Files can be up to 50 MB each.' : res.error)
    void load()
  }

  const removeFile = async (file: KnowledgeFile): Promise<void> => {
    setProblem(null)
    setDetail((d) => d && { ...d, files: d.files.filter((f) => f.id !== file.id) })
    const res = await api.knowledge.removeFile(id, file.id)
    if (!res.ok) setProblem(res.error)
    void load()
  }

  const remove = async (): Promise<void> => {
    setMenu(false)
    if (!detail) return
    const { name } = detail.base
    if (!window.confirm(`Delete “${name}” and its files? This cannot be undone.`)) return
    const res = await api.knowledge.remove(id)
    if (res.ok) {
      clearChat(id)
      onDeleted()
    } else setProblem(res.error)
  }

  if (!detail) {
    return (
      <div className="kb-view">
        <header className="kb-head">
          <button className="kb-back" onClick={onBack} title="All knowledge bases">
            <ChevronLeft /> Knowledge
          </button>
        </header>
        <div className="kb-state">
          {error ? (
            <>
              <CircleAlert />
              <p>{error}</p>
              <button className="btn btn-sm" onClick={() => void load()}>
                Try again
              </button>
            </>
          ) : (
            <span className="spinner" />
          )}
        </div>
      </div>
    )
  }

  const { base, files } = detail

  // The dialog sits outside the view: as a size container, the view would
  // otherwise hold its fixed backdrop inside itself.
  return (
    <>
      <div
        className={`kb-view${dragging ? ' is-dragging' : ''}`}
        onDragEnter={(e) => {
          if (!carriesFiles(e)) return
          e.preventDefault()
          depth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => {
          if (!carriesFiles(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(e) => {
          if (!carriesFiles(e)) return
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDragging(false)
        }}
        onDrop={(e) => {
          if (!carriesFiles(e)) return
          e.preventDefault()
          depth.current = 0
          setDragging(false)
          void upload(Array.from(e.dataTransfer.files))
        }}
      >
        <header className="kb-head">
          <button className="kb-back" onClick={onBack} title="All knowledge bases">
            <ChevronLeft /> Knowledge
          </button>
          <span className="kb-head-sep">/</span>
          <div className="kb-head-title">
            <b>{base.name}</b>
            <span>
              {files.length > 0
                ? `${plural(files.length, 'file')} · ${formatSize(base.tokens)}`
                : 'No files yet'}
            </span>
          </div>
          <Popover
            open={menu}
            onOpenChange={setMenu}
            align="end"
            placement="bottom"
            trigger={
              <button
                className="icon-btn"
                title="More"
                aria-label="More"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              >
                <Ellipsis />
              </button>
            }
          >
            <div className="menu kb-menu" role="menu">
              <button
                className="menu-item menu-action"
                role="menuitem"
                onClick={() => {
                  setMenu(false)
                  setRenaming(true)
                }}
              >
                <Pencil /> Rename
              </button>
              {talked && (
                <button
                  className="menu-item menu-action"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    clearChat(id)
                  }}
                >
                  <Eraser /> Clear conversation
                </button>
              )}
              <div className="menu-sep" />
              <button
                className="menu-item menu-action is-danger"
                role="menuitem"
                onClick={() => void remove()}
              >
                <Trash2 /> Delete knowledge base
              </button>
            </div>
          </Popover>
        </header>

        <div className="kb-body">
          <FilesPane
            files={files}
            uploading={uploading}
            dragging={dragging}
            description={base.description}
            problem={problem}
            onDismiss={() => setProblem(null)}
            onAdd={(picked) => void upload(picked)}
            onRemove={(file) => void removeFile(file)}
          />
          <KnowledgeChat
            baseId={id}
            name={base.name}
            files={files.length}
            processing={processing}
          />
        </div>

        {dragging && (
          <div className="kb-dropping" aria-hidden>
            <span>Drop to add to {base.name}</span>
          </div>
        )}
      </div>

      {renaming && (
        <BaseDialog
          base={base}
          onClose={() => setRenaming(false)}
          onSaved={(saved) => {
            setRenaming(false)
            setDetail((d) => d && { ...d, base: saved })
          }}
        />
      )}
    </>
  )
}
