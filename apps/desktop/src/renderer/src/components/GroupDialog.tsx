import { Check, CircleAlert, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Group } from '../../../shared/contracts'
import { joinable, useRoster } from '../store/roster'
import { AgentAvatar } from './AgentAvatar'
import { MAX_TEAMMATES } from './Team'

const MIN_MEMBERS = 2
const NAME_MAX = 40

/**
 * Make or change a group, in two steps: who is in it, then who leads. The
 * lead is asked for every time, with the first agent picked as the suggestion.
 */
export function GroupDialog({
  group,
  onClose,
  onSaved,
  onDeleted
}: {
  /** The group being changed; null makes a new one. */
  group: Group | null
  onClose: () => void
  onSaved: (group: Group) => void
  onDeleted: (id: string) => void
}): React.JSX.Element {
  const agents = useRoster((s) => s.agents)
  const saveGroup = useRoster((s) => s.saveGroup)
  const removeGroup = useRoster((s) => s.removeGroup)
  const pool = joinable(agents)

  const [step, setStep] = useState<'members' | 'lead'>('members')
  const [name, setName] = useState(group?.name ?? '')
  const [members, setMembers] = useState<string[]>(
    () => group?.members.filter((id) => pool.some((a) => a.id === id)) ?? []
  )
  const [lead, setLead] = useState<string | null>(group?.lead ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInput.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const chosen = members.flatMap((id) => pool.find((a) => a.id === id) ?? [])
  // The lead has to be in the group: the first agent picked, until the user says otherwise.
  const leading = lead && members.includes(lead) ? lead : (members[0] ?? null)
  const ready = name.trim().length > 0 && members.length >= MIN_MEMBERS
  const full = members.length >= MAX_TEAMMATES

  const toggle = (id: string): void =>
    setMembers((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const save = async (): Promise<void> => {
    if (!ready || !leading || saving) return
    setSaving(true)
    setError(null)
    const res = await saveGroup(group?.id ?? null, { name: name.trim(), members, lead: leading })
    setSaving(false)
    if (typeof res === 'string') setError(res)
    else onSaved(res)
  }

  const remove = async (): Promise<void> => {
    if (!group) return
    if (!window.confirm(`Delete ${group.name} and its conversations? The agents stay.`)) return
    await removeGroup(group.id)
    onDeleted(group.id)
  }

  const title = group ? `Edit ${group.name}` : 'New group'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-dialog-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (step === 'members') {
            if (ready) setStep('lead')
          } else void save()
        }}
      >
        <header className="modal-head">
          <div>
            <h2 id="group-dialog-title">{step === 'members' ? title : 'Who leads?'}</h2>
            <p>
              {step === 'members'
                ? 'Put agents in a group and talk to all of them at once.'
                : 'The lead reads your messages, decides who does what and gives the final answer.'}
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

        {step === 'members' ? (
          <div className="modal-body">
            <div className="field">
              <label htmlFor="group-name">Name</label>
              <input
                id="group-name"
                ref={nameInput}
                value={name}
                maxLength={NAME_MAX}
                placeholder="Launch team"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label id="group-agents-label">
                Agents
                <span>
                  {members.length} of {MAX_TEAMMATES}
                </span>
              </label>
              <div className="pick-list" role="group" aria-labelledby="group-agents-label">
                {pool.map((a) => {
                  const on = members.includes(a.id)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={on ? 'pick is-on' : 'pick'}
                      role="checkbox"
                      aria-checked={on}
                      disabled={!on && full}
                      onClick={() => toggle(a.id)}
                    >
                      <AgentAvatar agent={a} size={32} />
                      <span className="pick-text">
                        <b>{a.name}</b>
                        <span>{a.tagline}</span>
                      </span>
                      <span className="pick-box" aria-hidden>
                        {on && <Check />}
                      </span>
                    </button>
                  )
                })}
                {pool.length < MIN_MEMBERS && (
                  <div className="pick-empty">
                    A group needs at least two agents. Make another agent first.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <div className="pick-list" role="radiogroup" aria-label="Lead">
              {chosen.map((a) => {
                const on = a.id === leading
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={on ? 'pick is-on' : 'pick'}
                    role="radio"
                    aria-checked={on}
                    onClick={() => setLead(a.id)}
                  >
                    <AgentAvatar agent={a} size={32} />
                    <span className="pick-text">
                      <b>{a.name}</b>
                      <span>{a.tagline}</span>
                    </span>
                    {on && <span className="badge">Lead</span>}
                    <span className="pick-box is-radio" aria-hidden>
                      {on && <i />}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <footer className="modal-foot">
          {group && step === 'members' && (
            <button type="button" className="btn builder-delete" onClick={() => void remove()}>
              <Trash2 /> Delete group
            </button>
          )}
          <span className="composer-spacer" />
          {step === 'members' ? (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!ready}>
                Continue
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setStep('members')}>
                Back
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || !leading}>
                {saving ? 'Saving…' : group ? 'Save changes' : 'Create group'}
              </button>
            </>
          )}
        </footer>
      </form>
    </div>
  )
}
