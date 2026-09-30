import { parseSessionsListResult } from '../../../../../../src/rpcProxyClient'
import type { ChatIndex, SessionsListResult } from '../../../../../../src/types'

export const CATALOG_NOW = '2026-09-12T00:00:00.000Z'

/**
 * A server catalog page built by the REAL wire parser, so fixtures are derived
 * from the producer instead of hand-built parsed shapes.
 */
export function serverSessions(
  items: Array<{ agent: string; chatId: string; title?: string }>,
  nextCursor?: string
): SessionsListResult {
  return parseSessionsListResult({
    items: items.map(i => ({
      agent: i.agent,
      chatId: i.chatId,
      turnCount: 1,
      lastActivityAt: CATALOG_NOW,
      ...(i.title !== undefined ? { title: i.title } : {}),
    })),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  })
}

/** A local chat index whose tombstones carry the harness's authority scope. */
export function localIndex(
  chats: Array<{ id: string; title: string }>,
  deletedChatIds: string[] = []
): ChatIndex {
  const authorityScope = { environmentKey: 'env-test', userId: 'unknown-user', teamId: 'team-1' }
  return {
    version: 1,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: chats.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: CATALOG_NOW,
      updatedAt: CATALOG_NOW,
      messageCount: 0,
    })),
    deletedChatTombstones: deletedChatIds.map(chatId => ({ chatId, authorityScope })),
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish
    reject = fail
  })
  return { promise, resolve, reject }
}
