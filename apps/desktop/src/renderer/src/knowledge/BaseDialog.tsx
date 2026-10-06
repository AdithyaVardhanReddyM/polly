import { CircleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KnowledgeBase } from '../../../shared/contracts'
import { api } from '../api'

const NAME_MAX = 80
const DESCRIPTION_MAX = 280

interface Props {
  /** The base being renamed; null makes a new one. */
  base: KnowledgeBase | null
  onClose: () => void
  onSaved: (base: KnowledgeBase) => void
}

/** Name (and describe) a knowledge base. */
export function BaseDialog({ base, onClose, onSaved }: Props): React.JSX.Element {
  const [name, setName] = useState(base?.name ?? '')
  const [description, setDescription] = useState(base?.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInput.current?.focus()
    nameInput.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ready = name.trim().length > 0 && !saving

  const save = async (): Promise<void> => {
    if (!ready) return
    setSaving(true)
    setError(null)
    const fields = { name: name.trim(), description: description.trim() }
    const res = base
      ? await api.knowledge.update(base.id, fields)
      : await api.knowledge.create(fields)
    setSaving(false)
    if (res.ok) onSaved(res.data)
    else setError(res.error)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal kb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-dialog-title"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <header className="modal-head">
          <div>
            <h2 id="kb-dialog-title">{base ? 'Rename knowledge base' : 'New knowledge base'}</h2>
            <p>
              {base
                ? 'The name shows here and in the notch.'
                : 'A set of files Polly answers from, such as a product’s docs or a course’s readings.'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <X />
          </button>
        </header>

        {error && (
          <div className="banner is-error modal-error">
            <CircleAlert />
            <span>{error}</span>
          </div>
        )}

        <div className="modal-body">
          <div className="field">
            <label htmlFor="kb-name">Name</label>
            <input
              id="kb-name"
              ref={nameInput}
              value={name}
              maxLength={NAME_MAX}
              placeholder="Product handbook"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="kb-description">
              Description <span>Optional</span>
            </label>
            <textarea
              id="kb-description"
              value={description}
              maxLength={DESCRIPTION_MAX}
              rows={3}
              placeholder="What these files cover, so you can tell bases apart"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <footer className="modal-foot">
          <span className="composer-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            {saving ? 'Saving…' : base ? 'Save' : 'Create'}
          </button>
        </footer>
      </form>
    </div>
  )
}
