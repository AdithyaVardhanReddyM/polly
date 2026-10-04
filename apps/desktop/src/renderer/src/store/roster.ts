import { create } from 'zustand'
import type { AgentSummary, Group, GroupFields } from '../../../shared/contracts'
import { api } from '../api'

/**
 * Who there is to work with: every agent, the groups the user made, and
 * whether agents may call on anyone (open collaboration). `App` keeps the
 * agents in step with the server; the rest loads here.
 */
interface RosterState {
  agents: AgentSummary[]
  groups: Group[]
  /** Open collaboration: every agent may call on every other. */
  open: boolean

  setAgents: (agents: AgentSummary[]) => void
  load: () => Promise<void>
  setOpen: (open: boolean) => Promise<void>
  /** Returns the saved group, or the reason it could not be saved. */
  saveGroup: (id: string | null, fields: GroupFields) => Promise<Group | string>
  removeGroup: (id: string) => Promise<void>
}

export const useRoster = create<RosterState>((set, get) => ({
  agents: [],
  groups: [],
  open: false,

  setAgents(agents) {
    set({ agents })
  },

  async load() {
    const [groups, collaboration] = await Promise.all([api.groups.list(), api.team.collaboration()])
    set({
      groups: groups.ok ? groups.data : get().groups,
      open: collaboration.ok ? collaboration.data.open : get().open
    })
  },

  async setOpen(open) {
    set({ open })
    const res = await api.team.setCollaboration(open)
    set({ open: res.ok ? res.data.open : !open })
  },

  async saveGroup(id, fields) {
    const res = id ? await api.groups.update(id, fields) : await api.groups.create(fields)
    if (!res.ok) return res.error
    const others = get().groups.filter((g) => g.id !== res.data.id)
    set({ groups: [...others, res.data].sort((a, b) => a.created_at - b.created_at) })
    return res.data
  },

  async removeGroup(id) {
    const res = await api.groups.remove(id)
    if (res.ok) set({ groups: get().groups.filter((g) => g.id !== id) })
  }
}))

/** The agents other agents can hand work to. */
export const joinable = (agents: AgentSummary[]): AgentSummary[] => agents.filter((a) => a.can_join)

/** Find an agent by id, or by the name a model wrote for it. */
export function findAgent(agents: AgentSummary[], ref: string | undefined): AgentSummary | undefined {
  if (!ref) return undefined
  const key = ref.trim().replace(/^[@`]+|`+$/g, '').toLowerCase()
  return agents.find((a) => a.id.toLowerCase() === key || a.name.toLowerCase() === key)
}

/**
 * Who an agent can call on in a conversation: the conversation's own team if
 * the user set one, otherwise the agent's, or everyone under open collaboration.
 */
export function teamOf(
  agents: AgentSummary[],
  lead: AgentSummary | undefined,
  members: string[] | null | undefined,
  open: boolean
): AgentSummary[] {
  if (!lead) return []
  const pool = joinable(agents).filter((a) => a.id !== lead.id)
  if (members) return members.flatMap((id) => pool.find((a) => a.id === id) ?? [])
  if (open) return pool
  return lead.teammates.flatMap((id) => pool.find((a) => a.id === id) ?? [])
}

/** A group's agents, lead first, as they are now (a deleted agent drops out). */
export function membersOf(group: Group, agents: AgentSummary[], lead = group.lead): AgentSummary[] {
  const ids = [lead, ...group.members.filter((id) => id !== lead)]
  return ids.flatMap((id) => agents.find((a) => a.id === id) ?? [])
}
