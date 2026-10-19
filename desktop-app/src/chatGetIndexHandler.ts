import type { ChatAuthorityScope, ChatIndex } from './types.js'

export interface ChatGetIndexDependencies {
  store: {
    retryPendingDeleteCleanups(scope: ChatAuthorityScope, agentRef?: string): Promise<void>
    getIndex(agentRef: string): Promise<ChatIndex>
  }
  getChatDeletionFenceAuthority(): { authorityScope: ChatAuthorityScope }
  warnCleanupFailure(error: unknown): void
}

/**
 * chat:getIndex logic without Electron dependencies, so the chat-open benchmark
 * (scripts/bench-chat-open.mjs) measures the same code the IPC handler runs.
 *
 * Start deleted-chat artifact cleanup in the background and return the index
 * without waiting for it. The index keeps the durable tombstones the renderer
 * filters deleted chats with while their artifacts are still being removed.
 * Attach the rejection handler immediately; an authority or cleanup failure
 * is reported and the cleanup stays queued for a later read. Only this agent's
 * queue is retried, except that the store walks every agent once per bind.
 */
export async function runChatGetIndex(
  deps: ChatGetIndexDependencies,
  agentRef: string
): Promise<ChatIndex> {
  try {
    const authority = deps.getChatDeletionFenceAuthority()
    void deps.store
      .retryPendingDeleteCleanups(authority.authorityScope, agentRef)
      .catch(deps.warnCleanupFailure)
  } catch (error) {
    deps.warnCleanupFailure(error)
  }
  return deps.store.getIndex(agentRef)
}
