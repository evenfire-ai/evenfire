import { type ReactNode, createContext, useMemo } from 'react'
import { TaskTracker } from './taskTracker'

export const AgentTaskTrackerContext = createContext<TaskTracker | null>(null)

/**
 * Mounts a single `TaskTracker` high in the tree (above the chat controller) so
 * in-flight tasks survive controller re-renders and chat/agent switches. The
 * provider is callback-less; the app injects `onTerminal`/`onSuspended` via
 * `tracker.setCallbacks` (cross-ref D.3 M3) since those need app-level deps.
 */
export function AgentTaskTrackerProvider({ children }: { children: ReactNode }) {
  const tracker = useMemo(() => new TaskTracker(), [])
  return (
    <AgentTaskTrackerContext.Provider value={tracker}>{children}</AgentTaskTrackerContext.Provider>
  )
}
