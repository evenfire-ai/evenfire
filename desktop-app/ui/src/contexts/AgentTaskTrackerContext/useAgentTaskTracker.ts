import { useContext } from 'react'
import { AgentTaskTrackerContext } from './context'
import type { TaskTracker } from './taskTracker'

export function useAgentTaskTracker(): TaskTracker {
  const tracker = useContext(AgentTaskTrackerContext)
  if (!tracker) {
    throw new Error('useAgentTaskTracker must be used within AgentTaskTrackerProvider')
  }
  return tracker
}
