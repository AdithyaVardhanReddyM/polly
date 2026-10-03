import type { AgentSummary } from '../../../shared/contracts'
import type { TranscriptItem } from '../store/coder'

export type Subagent = Extract<TranscriptItem, { kind: 'subagent' }>
export type AvatarAgent = Pick<AgentSummary, 'avatar' | 'division' | 'name'>

/** What each helper is for, in three words. */
const ROLE: Record<string, string> = {
  explorer: 'Scouts the code',
  tester: 'Writes and runs tests',
  librarian: 'Looks up docs',
  'general-purpose': 'Takes on a task'
}

/**
 * Each helper is its own robot, so the user can tell them apart at a glance.
 * The look is fixed per role; an unknown role still gets a stable robot from
 * its name as the seed.
 */
const LOOK: Record<string, Record<string, string>> = {
  explorer: {
    eyesVariant: 'round',
    topVariant: 'dish',
    chestVariant: 'buttons',
    mouthVariant: 'line',
    bodyColor: '63e6be'
  },
  tester: {
    eyesVariant: 'square',
    topVariant: 'twin',
    chestVariant: 'vents',
    mouthVariant: 'grill',
    bodyColor: '69db7c'
  },
  librarian: {
    eyesVariant: 'happy',
    topVariant: 'lightbar',
    chestVariant: 'screen',
    mouthVariant: 'smile',
    bodyColor: 'ffd43b'
  },
  'general-purpose': {
    eyesVariant: 'plus',
    topVariant: 'studs',
    chestVariant: 'slot',
    mouthVariant: 'speaker',
    bodyColor: 'aeb8c2'
  }
}

export const title = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

export function roleOf(name: string): string {
  return ROLE[name] ?? 'Helps out'
}

/** The robot for a helper, tinted like its lead's division. */
export function crewMember(name: string, lead?: AvatarAgent): AvatarAgent {
  return {
    name: title(name),
    division: lead?.division ?? 'coding',
    avatar: { seed: `crew/${name}`, ...(LOOK[name] ?? {}) }
  }
}

/** The helpers the lead has called on in the current turn, in order. */
export function crewOf(items: TranscriptItem[]): Subagent[] {
  let start = 0
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') {
      start = i + 1
      break
    }
  }
  return items.slice(start).filter((it): it is Subagent => it.kind === 'subagent')
}

export const isBusy = (crew: Subagent[]): boolean => crew.some((m) => m.status === 'running')
