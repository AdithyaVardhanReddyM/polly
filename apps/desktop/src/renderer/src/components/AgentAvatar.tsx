import { Avatar, Style } from '@dicebear/core'
import definition from '@dicebear/styles/voxel-bot.json'
import { useMemo } from 'react'
import type { AgentSummary, Division } from '../../../shared/contracts'

// "Voxel Bot" by DiceBear (https://www.dicebear.com), CC0 1.0.
// Rendered locally: no network, works offline, same robot every time.
const style = new Style(definition as ConstructorParameters<typeof Style>[0])

/** Each division's tint sits behind its robots, so they read as a team. */
const BACKGROUND: Record<Division, string> = {
  coding: 'eef3fb',
  research: 'eaf5ee',
  everyday: 'fdf1e6',
  custom: 'f3eeff'
}

interface Props {
  agent: Pick<AgentSummary, 'avatar' | 'division' | 'name'>
  size?: number
  /** Animates the robot's glow; for an agent that is working. */
  active?: boolean
  /** Just the robot: no tile behind it. */
  bare?: boolean
  /** Idle motion (blinks, a small head lift); overrides `active`. */
  motion?: 'none' | 'slow' | 'medium' | 'fast' | 'fastest'
}

export function AgentAvatar({
  agent,
  size = 36,
  active = false,
  bare = false,
  motion
}: Props): React.JSX.Element {
  const src = useMemo(
    () =>
      new Avatar(style, {
        // Bare: a fully transparent tile (left unset, the style picks its own colour).
        backgroundColor: [bare ? '00000000' : BACKGROUND[agent.division]],
        borderRadius: bare ? 0 : 22,
        ...agent.avatar,
        animationVariant: motion ?? (active ? 'slow' : 'none')
      }).toDataUri(),
    [agent.avatar, agent.division, active, bare, motion]
  )

  return <img className="agent-avatar" src={src} width={size} height={size} alt={agent.name} />
}
