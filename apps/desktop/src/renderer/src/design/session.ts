import { api } from '../api'
import { createAgentStore } from '../store/agentSession'
import { setSessionMaker, useCanvas } from './store'

/** The chat with the Designer. Its events drive the canvas, and the canvas is
 *  saved before each message so the agent sees what the user just changed. */
export const useDesign = createAgentStore({
  agentIds: ['designer'],
  hash: 'design',
  onEvent: (event, sessionId) => useCanvas.getState().onAgentEvent(event, sessionId),
  beforeSend: () => useCanvas.getState().flush()
})

// A design started by hand gets its session on the first edit. It has no title
// until the first message names it.
setSessionMaker({
  async create() {
    const res = await api.sessions.create({
      agent_id: 'designer',
      title: '',
      model: useDesign.getState().model ?? undefined,
      reasoning_effort: useDesign.getState().effort ?? undefined
    })
    if (res.ok) return res.data.id
    useDesign.setState({ error: res.error })
    return null
  },
  open(id) {
    void useDesign.getState().open(id)
    void useDesign.getState().refresh()
  }
})
