import { ArrowUpRight, CircleAlert, Library, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeBase } from '../../../shared/contracts'
import { api } from '../api'
import { relativeTime } from '../coder/toolMeta'
import { PageHead } from '../components/PageHead'
import { BaseDialog } from '../knowledge/BaseDialog'
import { BaseView } from '../knowledge/BaseView'
import { formatSize, plural } from '../knowledge/format'

/** `#knowledge/<id>` opens that base, so a reload lands back on it. */
function openFromHash(): string | null {
  const id = window.location.hash.match(/^#knowledge\/([^/]+)/)?.[1]
  return id ? decodeURIComponent(id) : null
}

/** Knowledge bases: files Polly can answer from, here and from the notch. */
export function Knowledge(): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(openFromHash)

  const go = (id: string | null): void => {
    setOpenId(id)
    window.history.replaceState(
      null,
      '',
      id ? `#knowledge/${encodeURIComponent(id)}` : '#knowledge'
    )
  }

  return openId ? (
    <BaseView key={openId} id={openId} onBack={() => go(null)} onDeleted={() => go(null)} />
  ) : (
    <BaseList onOpen={go} />
  )
}

function BaseList({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [bases, setBases] = useState<KnowledgeBase[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const res = await api.knowledge.list()
    if (res.ok) {
      setBases([...res.data].sort((a, b) => b.updated_at - a.updated_at))
      setError(null)
    } else setError(res.error)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="kb-list">
      <div className="page kb-page">
        <PageHead
          title="Knowledge"
          subtitle="Files Polly can answer from — in chat here, and from the notch."
        >
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus /> New knowledge base
          </button>
        </PageHead>

        {bases === null && error && (
          <div className="kb-notice">
            <CircleAlert />
            <span>Knowledge bases did not load: {error}</span>
            <button className="btn btn-sm" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {bases === null && !error && (
          <div className="kb-loading">
            <span className="spinner" />
          </div>
        )}

        {bases?.length === 0 && (
          <div className="kb-first">
            <Library />
            <h2>No knowledge bases yet</h2>
            <p>
              Make one for each set of files you want answers from, such as a product’s docs, a
              contract pack or a course’s readings. Ask about them here, or from the notch.
            </p>
            <button className="btn" onClick={() => setCreating(true)}>
              <Plus /> New knowledge base
            </button>
          </div>
        )}

        {bases && bases.length > 0 && (
          <div className="ig-grid kb-grid">
            {bases.map((b) => (
              <BaseCard key={b.id} base={b} onOpen={() => onOpen(b.id)} />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <BaseDialog
          base={null}
          onClose={() => setCreating(false)}
          onSaved={(base) => {
            setCreating(false)
            onOpen(base.id)
          }}
        />
      )}
    </div>
  )
}

function BaseCard({
  base,
  onOpen
}: {
  base: KnowledgeBase
  onOpen: () => void
}): React.JSX.Element {
  return (
    <article
      className="ig-card kb-card"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen()
      }}
    >
      <div className="ig-card-head">
        <span className="kb-card-icon">
          <Library />
        </span>
        <div className="ig-card-title">
          <h3>{base.name}</h3>
          <span>
            {base.files > 0
              ? `${plural(base.files, 'file')} · ${formatSize(base.tokens)}`
              : 'No files yet'}
          </span>
        </div>
      </div>
      <p className={base.description ? 'ig-card-desc' : 'ig-card-desc is-blank'}>
        {base.description || 'No description'}
      </p>
      <div className="ig-card-foot">
        <span className="kb-card-updated">Updated {relativeTime(base.updated_at)}</span>
        <ArrowUpRight className="ig-card-arrow" />
      </div>
    </article>
  )
}
