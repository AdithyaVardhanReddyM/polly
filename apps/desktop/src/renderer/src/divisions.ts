import type { Division } from '../../shared/contracts'

export const DIVISIONS: { id: Division; label: string; blurb: string }[] = [
  { id: 'coding', label: 'Coding', blurb: 'Write, design, review and ship software.' },
  { id: 'research', label: 'Research', blurb: 'Find, read and synthesise what is out there.' },
  { id: 'everyday', label: 'Everyday', blurb: 'Inbox, calendar and the rest of your day.' },
  { id: 'custom', label: 'Yours', blurb: 'Agents you build from instructions, tools and apps.' }
]
