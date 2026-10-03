import { createAgentStore } from '../store/agentSession'
import { useCanvas } from './store'

/** The chat with the Designer. Its events drive the canvas, and the canvas is
 *  saved before each message so the agent sees what the user just changed. */
export const useDesign = createAgentStore({
  agentIds: ['designer'],
  hash: 'design',
  onEvent: (event, sessionId) => useCanvas.getState().onAgentEvent(event, sessionId),
  beforeSend: () => useCanvas.getState().flush()
})
