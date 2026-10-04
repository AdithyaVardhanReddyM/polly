import { Check, Users } from 'lucide-react'
import { useState } from 'react'
import type { AgentSummary } from '../../../shared/contracts'
import { Popover } from '../coder/Composer'
import type { AgentStore } from '../store/agentSession'
import { joinable, teamOf, useRoster } from '../store/roster'
import { AgentAvatar } from './AgentAvatar'

/** The most teammates an agent, or a conversation, can have (`team.py`). */
export const MAX_TEAMMATES = 8

/** A few agents side by side, then how many more. */
export function AvatarRow({
  agents,
  size = 20,
  max = 4
}: {
  agents: AgentSummary[]
  size?: number
  max?: number
}): React.JSX.Element {
  const shown = agents.length > max ? agents.slice(0, max - 1) : agents
  const more = agents.length - shown.length
  return (
    <span className="avatar-row">
      {shown.map((a) => (
        <AgentAvatar key={a.id} agent={a} size={size} bare />
      ))}
      {more > 0 && <span className="avatar-more">+{more}</span>}
    </span>
  )
}

/** A group's picture: its first few agents, together on one tile. */
export function GroupAvatar({
  members,
  size = 44
}: {
  members: AgentSummary[]
  size?: number
}): React.JSX.Element {
  const shown = members.slice(0, 4)
  const cell = Math.round(size * (shown.length <= 1 ? 0.7 : shown.length === 2 ? 0.46 : 0.42))
  return (
    <span className={`group-avatar is-${shown.length}`} style={{ width: size, height: size }}>
      {shown.map((a) => (
        <AgentAvatar key={a.id} agent={a} size={cell} bare />
      ))}
    </span>
  )
}

/** A list of agents to tick: who is on a team. */
export function TeamMenu({
  label,
  pool,
  picked,
  onToggle,
  note
}: {
  label: string
  /** The agents that can be chosen. */
  pool: AgentSummary[]
  picked: string[]
  onToggle: (id: string) => void
  /** A line under the list: what the choice applies to. */
  note?: React.ReactNode
}): React.JSX.Element {
  const full = picked.length >= MAX_TEAMMATES
  return (
    <div className="menu team-menu" role="group" aria-label={label}>
      <div className="menu-label">{label}</div>
      {pool.length === 0 && <div className="team-menu-empty">No other agents to call on yet.</div>}
      {pool.map((a) => {
        const on = picked.includes(a.id)
        return (
          <button
            key={a.id}
            className="menu-item"
            role="menuitemcheckbox"
            aria-checked={on}
            disabled={!on && full}
            onClick={() => onToggle(a.id)}
          >
            <AgentAvatar agent={a} size={28} />
            <span className="menu-text">
              <b>{a.name}</b>
              <span>{a.tagline}</span>
            </span>
            {on && <Check className="menu-check" />}
          </button>
        )
      })}
      {note && <div className="menu-foot">{note}</div>}
    </div>
  )
}

const toggled = (ids: string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]

/**
 * In a chat's header: who the agent can call on in this conversation, and a
 * menu to change it. The choice is the conversation's; the agent's usual team
 * is set on the Agents page.
 */
export function TeamButton({
  store,
  lead
}: {
  store: AgentStore
  lead: AgentSummary
}): React.JSX.Element {
  const agents = useRoster((s) => s.agents)
  const everyone = useRoster((s) => s.open)
  const members = store((s) => s.members)
  const setMembers = store((s) => s.setMembers)
  const [open, setOpen] = useState(false)

  const team = teamOf(agents, lead, members, everyone)
  const pool = joinable(agents).filter((a) => a.id !== lead.id)
  const label =
    team.length === 0
      ? 'Add teammates'
      : `Working with ${team.map((a) => a.name).join(', ')}`

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom"
      align="end"
      trigger={
        <button
          className={`team-btn${open ? ' is-open' : ''}${team.length ? '' : ' is-empty'}`}
          title={label}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Users />
          {team.length > 0 ? <AvatarRow agents={team} size={20} max={4} /> : <span>Team</span>}
        </button>
      }
    >
      <TeamMenu
        label={`${lead.name} can hand work to`}
        pool={pool}
        picked={team.map((a) => a.id)}
        onToggle={(id) =>
          void setMembers(
            toggled(
              team.map((a) => a.id),
              id
            )
          )
        }
        note="For this conversation. Type @ in a message to bring an agent in."
      />
    </Popover>
  )
}

/**
 * On an agent's card: its usual team, and a menu to change it. Saved for the
 * agent, so every new conversation with it starts with these teammates.
 */
export function TeamField({
  agent,
  onChanged
}: {
  agent: AgentSummary
  onChanged: (ids: string[]) => void
}): React.JSX.Element {
  const agents = useRoster((s) => s.agents)
  const [open, setOpen] = useState(false)
  const pool = joinable(agents).filter((a) => a.id !== agent.id)
  const team = agent.teammates.flatMap((id) => pool.find((a) => a.id === id) ?? [])

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="top"
      trigger={
        <button
          className={open ? 'team-field is-open' : 'team-field'}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Users />
          {team.length > 0 ? (
            <>
              <span>Works with</span>
              <AvatarRow agents={team} size={18} max={5} />
            </>
          ) : (
            <span>Add teammates</span>
          )}
        </button>
      }
    >
      <TeamMenu
        label={`${agent.name} can hand work to`}
        pool={pool}
        picked={team.map((a) => a.id)}
        onToggle={(id) =>
          onChanged(
            toggled(
              team.map((a) => a.id),
              id
            )
          )
        }
        note="Its team in every new conversation."
      />
    </Popover>
  )
}
