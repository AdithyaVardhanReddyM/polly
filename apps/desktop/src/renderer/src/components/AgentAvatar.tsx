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
}

export function AgentAvatar({ agent, size = 36, active = false }: Props): React.JSX.Element {
  const src = useMemo(
    () =>
      new Avatar(style, {
        backgroundColor: [BACKGROUND[agent.division]],
        borderRadius: 22,
        ...agent.avatar,
        animationVariant: active ? 'slow' : 'none'
      }).toDataUri(),
    [agent.avatar, agent.division, active]
  )

  return <img className="agent-avatar" src={src} width={size} height={size} alt={agent.name} />
}
