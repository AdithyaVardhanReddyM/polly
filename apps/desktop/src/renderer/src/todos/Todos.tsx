import { Bell, CalendarClock, Check, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TodoFields, TodoItem, TodoPatch } from '../../../shared/contracts'
import { api } from '../api'
import { Popover } from '../coder/Composer'
import { relativeTime } from '../coder/toolMeta'
import { useRoster } from '../store/roster'
import { friendlyWhen, fromLocalInput, fullWhen, nextHour, quickTimes, toLocalInput } from './when'

const REFRESH_MS = 30_000
/** How long a finished or deleted to-do stays put, with an undo. */
const UNDO_MS = 5_000
/** "Recently" done. */
const RECENT_DAYS = 14
const RECENT_MAX = 20
/** The id a to-do has here until the server has saved it. */
const DRAFT = 'draft-'

/** A to-do just checked off or deleted: it stays in place until the undo runs out. */
interface Held {
  kind: 'done' | 'deleted'
  from: 'open' | 'done'
}

const now = (): number => Math.floor(Date.now() / 1000)

/** Soonest due first, then the ones without a date, newest first. */
function byDue(a: TodoItem, b: TodoItem): number {
  if (a.due_at !== b.due_at) {
    if (a.due_at === null) return 1
    if (b.due_at === null) return -1
    return a.due_at - b.due_at
  }
  return b.created_at - a.created_at
}

/** To-dos and reminders, on Home. */
export function Todos(): React.JSX.Element {
  const [open, setOpen] = useState<TodoItem[] | null>(null)
  const [done, setDone] = useState<TodoItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [held, setHeld] = useState<Record<string, Held>>({})
  const [showDone, setShowDone] = useState(false)
  const heldRef = useRef(held)
  const openRef = useRef(open)
  const timers = useRef(new Map<string, number>())
  const agents = useRoster((s) => s.agents)

  useEffect(() => {
    heldRef.current = held
  }, [held])

  useEffect(() => {
    openRef.current = open
  }, [open])

  const load = useCallback(async () => {
    const [o, d] = await Promise.all([api.todos.list('open'), api.todos.list('done')])
    if (o.ok) {
      setError(null)
      // One just checked off is done on the server, but stays here until its undo runs out.
      setOpen((prev) => {
        const keep = (prev ?? []).filter(
          (t) => heldRef.current[t.id]?.from === 'open' && !o.data.some((s) => s.id === t.id)
        )
        return [...o.data, ...keep]
      })
    } else setError(o.error)
    if (d.ok) setDone(d.data)
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  // Leaving Home finishes what was waiting on an undo.
  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((t) => window.clearTimeout(t))
      pending.clear()
      for (const [id, h] of Object.entries(heldRef.current)) {
        if (h.kind === 'deleted') void api.todos.remove(id)
      }
    }
  }, [])

  useEffect(() => {
    if (!problem) return
    const t = window.setTimeout(() => setProblem(null), 6000)
    return () => window.clearTimeout(t)
  }, [problem])

  const put = (item: TodoItem): void => {
    setOpen((list) => list?.map((t) => (t.id === item.id ? item : t)) ?? list)
    setDone((list) => list.map((t) => (t.id === item.id ? item : t)))
  }

  const release = (id: string): void => {
    window.clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setHeld(({ [id]: _, ...rest }) => rest)
  }

  /** The undo ran out: move a finished to-do to Done, or really delete one. */
  const settle = (id: string): void => {
    const h = heldRef.current[id]
    release(id)
    if (!h) return
    if (h.kind === 'done') {
      const item = openRef.current?.find((t) => t.id === id)
      if (item) setDone((list) => [item, ...list.filter((t) => t.id !== id)])
      setOpen((list) => list?.filter((t) => t.id !== id) ?? list)
      return
    }
    setOpen((list) => list?.filter((t) => t.id !== id) ?? list)
    setDone((list) => list.filter((t) => t.id !== id))
    void api.todos.remove(id).then((res) => {
      if (!res.ok) {
        setProblem(res.error)
        void load()
      }
    })
  }

  const hold = (id: string, h: Held): void => {
    window.clearTimeout(timers.current.get(id))
    setHeld((all) => ({ ...all, [id]: h }))
    timers.current.set(
      id,
      window.setTimeout(() => settle(id), UNDO_MS)
    )
  }

  const save = async (item: TodoItem, change: TodoPatch): Promise<void> => {
    put({ ...item, ...change, updated_at: now() })
    const res = await api.todos.update(item.id, change)
    if (res.ok) put(res.data)
    else {
      put(item)
      setProblem(res.error)
    }
  }

  const add = async (fields: TodoFields): Promise<void> => {
    const at = now()
    const draft: TodoItem = {
      id: `${DRAFT}${Date.now()}`,
      title: fields.title,
      notes: '',
      due_at: fields.due_at ?? null,
      remind_at: fields.remind_at ?? null,
      reminded_at: null,
      status: 'open',
      source: { kind: 'user' },
      created_at: at,
      updated_at: at,
      completed_at: null
    }
    setOpen((list) => [...(list ?? []), draft])
    const res = await api.todos.create({ ...fields, source: { kind: 'user' } })
    setOpen((list) =>
      (list ?? []).flatMap((t) => (t.id === draft.id ? (res.ok ? [res.data] : []) : [t]))
    )
    if (!res.ok) setProblem(res.error)
  }

  const complete = (item: TodoItem): void => {
    const finished: TodoItem = { ...item, status: 'done', completed_at: now() }
    put(finished)
    hold(item.id, { kind: 'done', from: 'open' })
    void api.todos.update(item.id, { status: 'done' }).then((res) => {
      if (res.ok) return
      release(item.id)
      put(item)
      setProblem(res.error)
    })
  }

  const reopen = (item: TodoItem): void => {
    const again: TodoItem = { ...item, status: 'open', completed_at: null }
    setDone((list) => list.filter((t) => t.id !== item.id))
    setOpen((list) => [...(list ?? []).filter((t) => t.id !== item.id), again])
    void api.todos.update(item.id, { status: 'open' }).then((res) => {
      if (res.ok) put(res.data)
      else {
        setProblem(res.error)
        void load()
      }
    })
  }

  const undo = (item: TodoItem): void => {
    const h = held[item.id]
    release(item.id)
    if (h?.kind === 'done') reopen(item)
  }

  const nameOf = (agentId: string | null | undefined): string | undefined =>
    agents.find((a) => a.id === agentId)?.name

  const rows = useMemo(() => (open ? [...open].sort(byDue) : []), [open])
  const recent = useMemo(() => {
    const since = now() - RECENT_DAYS * 86_400
    return done
      .filter((t) => held[t.id]?.from !== 'open' && (t.completed_at ?? t.updated_at) >= since)
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
      .slice(0, RECENT_MAX)
  }, [done, held])
  const count = rows.filter((t) => t.status === 'open' && !held[t.id]).length

  const row = (item: TodoItem): React.JSX.Element => {
    // Just added: nothing to change on the server until it has an id there.
    const saved = !item.id.startsWith(DRAFT)
    return (
      <TodoRow
        key={item.id}
        item={item}
        held={held[item.id]?.kind}
        agentName={nameOf(item.source.agent_id)}
        onToggle={() => {
          if (!saved) return
          if (item.status === 'open') complete(item)
          else if (held[item.id]) undo(item)
          else reopen(item)
        }}
        onUndo={() => undo(item)}
        onRename={(title) => saved && void save(item, { title })}
        onWhen={(due_at, remind_at) => saved && void save(item, { due_at, remind_at })}
        onDelete={() =>
          saved &&
          hold(item.id, { kind: 'deleted', from: item.status === 'open' ? 'open' : 'done' })
        }
      />
    )
  }

  return (
    <section className="todos" aria-label="To-dos">
      <div className="section-head">
        <h2>To-dos</h2>
        {count > 0 && <span>{count} open</span>}
      </div>

      <AddTodo onAdd={(fields) => void add(fields)} />

      {open === null && error && (
        <p className="td-quiet">
          To-dos did not load: {error}.{' '}
          <button className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {open !== null && rows.length === 0 && (
        <p className="td-quiet">
          Polly adds to-dos it spots on screen while the copilot is on (⌃⌥P), and agents can add
          them too.
        </p>
      )}

      {rows.length > 0 && <div className="td-list">{rows.map(row)}</div>}

      {problem && (
        <p className="td-quiet is-error">
          {problem}
          <button className="icon-btn" title="Dismiss" onClick={() => setProblem(null)}>
            <X />
          </button>
        </p>
      )}

      {recent.length > 0 && (
        <button
          className={showDone ? 'td-done-toggle is-open' : 'td-done-toggle'}
          aria-expanded={showDone}
          onClick={() => setShowDone(!showDone)}
        >
          <ChevronRight /> Done <span>{recent.length}</span>
        </button>
      )}
      {showDone && recent.length > 0 && <div className="td-list is-done">{recent.map(row)}</div>}
    </section>
  )
}

/** Where a to-do came from, when it was not typed in here. */
function sourceLine(item: TodoItem, agentName: string | undefined): string | null {
  const s = item.source
  if (s.kind === 'agent') return `From ${agentName ?? 'an agent'}`
  if (s.kind !== 'copilot') return null
  const where = [s.app, s.window].filter(Boolean).join(' · ')
  return where ? `From ${where}` : 'Spotted on screen'
}

interface RowProps {
  item: TodoItem
  held: Held['kind'] | undefined
  agentName: string | undefined
  onToggle: () => void
  onUndo: () => void
  onRename: (title: string) => void
  onWhen: (due: number | null, remind: number | null) => void
  onDelete: () => void
}

function TodoRow({
  item,
  held,
  agentName,
  onToggle,
  onUndo,
  onRename,
  onWhen,
  onDelete
}: RowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [picking, setPicking] = useState(false)
  const isDone = item.status === 'done'

  if (held === 'deleted') {
    return (
      <div className="td-row is-gone">
        <span className="td-gone">Deleted “{item.title}”</span>
        <button className="link" onClick={onUndo}>
          Undo
        </button>
      </div>
    )
  }

  const startEdit = (): void => {
    setTitle(item.title)
    setEditing(true)
  }
  const finishEdit = (): void => {
    setEditing(false)
    const next = title.trim()
    if (next && next !== item.title) onRename(next)
  }

  const source = sourceLine(item, agentName)
  const overdue = !isDone && item.due_at !== null && item.due_at < now()
  const tip = [item.source.excerpt, item.source.url].filter(Boolean).join('\n') || undefined
  const reminds = item.remind_at !== null ? `Reminds you ${fullWhen(item.remind_at)}` : null
  // The due date, with a bell when it also reminds; or just the reminder.
  const when =
    item.due_at !== null ? (
      <span
        className={overdue ? 'td-when-label is-overdue' : 'td-when-label'}
        title={[`Due ${fullWhen(item.due_at)}`, reminds].filter(Boolean).join('\n')}
      >
        {reminds && <Bell />}
        {friendlyWhen(item.due_at)}
      </span>
    ) : item.remind_at !== null ? (
      <span className="td-when-label" title={reminds ?? undefined}>
        <Bell />
        {friendlyWhen(item.remind_at)}
      </span>
    ) : null
  const sub = !editing && (source || (isDone ? item.completed_at !== null : when))

  return (
    <div className={`td-row${isDone ? ' is-done' : ''}${picking || editing ? ' is-active' : ''}`}>
      <button
        className="td-check"
        role="checkbox"
        aria-checked={isDone}
        aria-label={isDone ? `Mark “${item.title}” not done` : `Mark “${item.title}” done`}
        onClick={onToggle}
      >
        <Check />
      </button>

      <div className="td-body">
        {editing ? (
          <input
            className="td-edit"
            value={title}
            autoFocus
            aria-label="To-do"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={finishEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) finishEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <div className="td-title" onDoubleClick={isDone ? undefined : startEdit}>
            {item.title}
          </div>
        )}
        {sub && (
          <div className="td-sub">
            {isDone
              ? item.completed_at !== null && <span>Done {relativeTime(item.completed_at)}</span>
              : when}
            {source && (
              <span className="td-source" title={tip}>
                {source}
              </span>
            )}
          </div>
        )}
      </div>

      {held === 'done' ? (
        <button className="link td-undo" onClick={onUndo}>
          Undo
        </button>
      ) : (
        <>
          <span className="td-actions">
            {!isDone && (
              <>
                <button className="icon-btn" title="Edit" onClick={startEdit}>
                  <Pencil />
                </button>
                <Popover
                  open={picking}
                  onOpenChange={setPicking}
                  align="end"
                  placement="bottom"
                  trigger={
                    <button
                      className="icon-btn"
                      title={item.remind_at !== null ? 'Change reminder' : 'Set a reminder'}
                      aria-expanded={picking}
                      onClick={() => setPicking(!picking)}
                    >
                      <Bell />
                    </button>
                  }
                >
                  <WhenPicker
                    due={item.due_at}
                    remind={item.remind_at}
                    focus="remind"
                    saveLabel="Save"
                    onCancel={() => setPicking(false)}
                    onSave={(due, remind) => {
                      setPicking(false)
                      if (due !== item.due_at || remind !== item.remind_at) onWhen(due, remind)
                    }}
                  />
                </Popover>
              </>
            )}
            <button className="icon-btn" title="Delete" onClick={onDelete}>
              <Trash2 />
            </button>
          </span>
        </>
      )}
    </div>
  )
}

/** The add row: Enter adds; the calendar sets a due date and a reminder. */
function AddTodo({ onAdd }: { onAdd: (fields: TodoFields) => void }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState<number | null>(null)
  const [remind, setRemind] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)
  const when = due ?? remind

  const submit = (): void => {
    if (!title.trim()) return
    onAdd({ title: title.trim(), due_at: due, remind_at: remind })
    setTitle('')
    setDue(null)
    setRemind(null)
  }

  return (
    <form
      className="td-add"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Plus className="td-add-icon" />
      <input
        value={title}
        placeholder="Add a to-do"
        aria-label="Add a to-do"
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
      />
      {when !== null && (
        <span className="td-add-when" title={fullWhen(when)}>
          {remind !== null && <Bell />}
          {friendlyWhen(when)}
          <button
            type="button"
            className="td-add-clear"
            title="No date"
            onClick={() => {
              setDue(null)
              setRemind(null)
            }}
          >
            <X />
          </button>
        </span>
      )}
      <Popover
        open={picking}
        onOpenChange={setPicking}
        align="end"
        placement="bottom"
        trigger={
          <button
            type="button"
            className="icon-btn"
            title="Due date and reminder"
            aria-expanded={picking}
            onClick={() => setPicking(!picking)}
          >
            <CalendarClock />
          </button>
        }
      >
        <WhenPicker
          due={due}
          remind={remind}
          focus="due"
          saveLabel="Set"
          onCancel={() => setPicking(false)}
          onSave={(d, r) => {
            setDue(d)
            setRemind(r)
            setPicking(false)
          }}
        />
      </Popover>
    </form>
  )
}

/** A due date and a reminder, each optional. */
function WhenPicker({
  due,
  remind,
  focus,
  saveLabel,
  onSave,
  onCancel
}: {
  due: number | null
  remind: number | null
  focus: 'due' | 'remind'
  saveLabel: string
  onSave: (due: number | null, remind: number | null) => void
  onCancel: () => void
}): React.JSX.Element {
  const [dueText, setDueText] = useState(toLocalInput(due))
  const [reminding, setReminding] = useState(remind !== null || focus === 'remind')
  const [remindText, setRemindText] = useState(toLocalInput(remind ?? due ?? nextHour()))
  const picks = useMemo(() => quickTimes(), [])

  const save = (): void =>
    onSave(fromLocalInput(dueText), reminding ? fromLocalInput(remindText) : null)

  return (
    <div
      className="menu td-when"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          save()
        }
      }}
    >
      <div className="td-when-field">
        <label htmlFor="td-when-due">Due</label>
        <div className="td-when-input">
          <input
            id="td-when-due"
            type="datetime-local"
            value={dueText}
            autoFocus={focus === 'due'}
            onChange={(e) => setDueText(e.target.value)}
          />
          {dueText && (
            <button
              type="button"
              className="icon-btn"
              title="No due date"
              onClick={() => setDueText('')}
            >
              <X />
            </button>
          )}
        </div>
        <div className="td-quick">
          {picks.map((p) => (
            <button
              type="button"
              key={p.label}
              title={fullWhen(p.at)}
              onClick={() => {
                setDueText(toLocalInput(p.at))
                if (reminding && !remind) setRemindText(toLocalInput(p.at))
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="td-when-field">
        <label className="td-when-switch">
          <input
            type="checkbox"
            className="switch"
            checked={reminding}
            onChange={(e) => {
              setReminding(e.target.checked)
              if (e.target.checked && !remind)
                setRemindText(toLocalInput(fromLocalInput(dueText) ?? nextHour()))
            }}
          />
          Remind me
        </label>
        {reminding && (
          <div className="td-when-input">
            <input
              type="datetime-local"
              value={remindText}
              aria-label="Reminder"
              autoFocus={focus === 'remind'}
              onChange={(e) => setRemindText(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="td-when-foot">
        <span className="composer-spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save}>
          {saveLabel}
        </button>
      </div>
    </div>
  )
}
