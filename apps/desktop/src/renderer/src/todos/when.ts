/** Dates for to-dos: friendly labels, and the `datetime-local` input's format. */

const DAY = 86_400_000

const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

const pad = (n: number): string => String(n).padStart(2, '0')

/** "10:00" */
export const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** "Today 10:00", "Tomorrow", "Yesterday", "Wed 5 Nov", "5 Nov 2027". */
export function friendlyWhen(epochSeconds: number, now = new Date()): string {
  const d = new Date(epochSeconds * 1000)
  const days = Math.round((midnight(d) - midnight(now)) / DAY)
  const time = d.getHours() || d.getMinutes() ? ` ${clock(d)}` : ''
  if (days === 0) return `Today${time}`
  if (days === 1) return `Tomorrow${time}`
  if (days === -1) return `Yesterday${time}`
  if (d.getFullYear() !== now.getFullYear()) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** The whole date and time, for tooltips. */
export const fullWhen = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })

/** Epoch seconds → the value a `datetime-local` input takes ("2026-10-07T09:00"). */
export function toLocalInput(epochSeconds: number | null): string {
  if (epochSeconds === null) return ''
  const d = new Date(epochSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${clock(d)}`
}

/** A `datetime-local` value (local time) → epoch seconds; null when empty or invalid. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

const at = (base: Date, dayOffset: number, hour: number): number =>
  Math.floor(
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour).getTime() / 1000
  )

/** A few common times to pick with one click. */
export function quickTimes(now = new Date()): { label: string; at: number }[] {
  const picks: { label: string; at: number }[] = []
  if (now.getHours() < 17) picks.push({ label: 'This evening', at: at(now, 0, 18) })
  picks.push({ label: 'Tomorrow', at: at(now, 1, 9) })
  // Monday at nine; a week on when today is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7
  picks.push({ label: 'Next week', at: at(now, toMonday, 9) })
  return picks
}

/** The next whole hour from now, for a reminder with nothing to go on. */
export function nextHour(now = new Date()): number {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return Math.floor(d.getTime() / 1000)
}
