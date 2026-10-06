import { Check, CircleAlert, Plus, Trash2, Upload, X } from 'lucide-react'
import { useRef } from 'react'
import type { KnowledgeFile } from '../../../shared/contracts'
import { FileIcon } from '../coder/icons'
import { formatBytes, formatSize, plural } from './format'

interface Props {
  files: KnowledgeFile[]
  /** Names of the files on their way up. */
  uploading: string[]
  /** Files are being dragged over the base. */
  dragging: boolean
  description: string
  problem: string | null
  onDismiss: () => void
  onAdd: (files: File[]) => void
  onRemove: (file: KnowledgeFile) => void
}

/** A base's files: add them (drop or browse), see how reading them went, remove them. */
export function FilesPane({
  files,
  uploading,
  dragging,
  description,
  problem,
  onDismiss,
  onAdd,
  onRemove
}: Props): React.JSX.Element {
  const picker = useRef<HTMLInputElement>(null)
  const browse = (): void => picker.current?.click()
  const empty = files.length === 0 && uploading.length === 0

  return (
    <aside className="kb-files">
      {description && <p className="kb-description">{description}</p>}

      <div className="kb-files-head">
        <h2>Files</h2>
        {files.length > 0 && <span>{files.length}</span>}
        <span className="composer-spacer" />
        <button className="btn btn-sm" onClick={browse}>
          <Plus /> Add files
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (picked.length) onAdd(picked)
          }}
        />
      </div>

      <button
        type="button"
        className={`kb-drop${dragging ? ' is-over' : ''}${empty ? ' is-empty' : ''}`}
        onClick={browse}
      >
        <Upload />
        <span>
          Drop files here or <span className="kb-drop-link">browse</span>
        </span>
        {empty && <small>PDF, Word, Excel, Markdown, text, CSV, HTML and images</small>}
      </button>

      {problem && (
        <div className="banner is-error kb-problem">
          <CircleAlert />
          <span>{problem}</span>
          <button className="icon-btn" onClick={onDismiss} title="Dismiss">
            <X />
          </button>
        </div>
      )}

      {!empty && (
        <ul className="kb-file-list">
          {uploading.map((name, i) => (
            <li key={`up-${i}-${name}`} className="kb-file is-uploading">
              <FileIcon name={name} className="kb-file-icon" />
              <div className="kb-file-body">
                <div className="kb-file-name">{name}</div>
                <div className="kb-file-meta">Uploading…</div>
              </div>
              <span className="kb-file-state">
                <span className="spinner is-small" />
              </span>
            </li>
          ))}
          {files.map((f) => (
            <FileRow key={f.id} file={f} onRemove={() => onRemove(f)} />
          ))}
        </ul>
      )}
    </aside>
  )
}

function FileRow({
  file,
  onRemove
}: {
  file: KnowledgeFile
  onRemove: () => void
}): React.JSX.Element {
  const meta = [
    formatBytes(file.size),
    file.pages ? plural(file.pages, 'page') : null,
    file.status === 'ready' && file.tokens ? formatSize(file.tokens) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className={`kb-file is-${file.status}`}>
      <FileIcon name={file.name} className="kb-file-icon" />
      <div className="kb-file-body">
        <div className="kb-file-name" title={file.name}>
          {file.name}
        </div>
        <div className="kb-file-meta">{meta}</div>
        {file.status === 'error' && (
          <div className="kb-file-error">{file.error || 'Polly could not read this file.'}</div>
        )}
      </div>
      <span className="kb-file-state">
        {file.status === 'processing' && (
          <>
            <span className="spinner is-small" /> Processing
          </>
        )}
        {file.status === 'ready' && (
          <>
            <Check /> Ready
          </>
        )}
        {file.status === 'error' && (
          <>
            <CircleAlert /> Failed
          </>
        )}
      </span>
      <button className="icon-btn kb-file-remove" title={`Remove ${file.name}`} onClick={onRemove}>
        <Trash2 />
      </button>
    </li>
  )
}
