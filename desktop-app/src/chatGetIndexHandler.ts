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
 * The catalog read must never depend on the deleted-chat artifact cleanup:
 * a cleanup failure (scope changed mid-flight, no session, an unreadable
 * chats directory) would otherwise reject the read and leave the renderer
 * without the tombstones it filters deleted chats with. The failure is
 * reported and the cleanup stays queued for the next read. Only this agent's
 * queue is retried (the renderer reads every agent in a fan-out); the store
 * walks every agent once per bind on its own.
 */
export async function runChatGetIndex(
  deps: ChatGetIndexDependencies,
  agentRef: string
): Promise<ChatIndex> {
  try {
    const authority = deps.getChatDeletionFenceAuthority()
    await deps.store.retryPendingDeleteCleanups(authority.authorityScope, agentRef)
  } catch (error) {
    deps.warnCleanupFailure(error)
  }
  return deps.store.getIndex(agentRef)
}
