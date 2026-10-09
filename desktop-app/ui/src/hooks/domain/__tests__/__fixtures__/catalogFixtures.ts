import { vi } from 'vitest'
import { parseSessionsListResult } from '../../../../../../src/rpcProxyClient'
import { RpcProxyClient } from '../../../../../../src/rpcProxyClient'
import type {
  ChatIndex,
  SessionMessagesResult,
  SessionsListResult,
} from '../../../../../../src/types'

export const CATALOG_NOW = '2026-09-12T00:00:00.000Z'

/**
 * A server catalog page built by the REAL wire parser, so fixtures are derived
 * from the producer instead of hand-built parsed shapes.
 */
export function serverSessions(
  items: Array<{
    agent: string
    chatId: string
    title?: string
    turnCount?: number
    messageCount?: number
    lastActivityAt?: string
  }>,
  nextCursor?: string
): SessionsListResult {
  return parseSessionsListResult({
    items: items.map(i => ({
      agent: i.agent,
      chatId: i.chatId,
      turnCount: i.turnCount ?? 1,
      ...(i.messageCount !== undefined ? { messageCount: i.messageCount } : {}),
      lastActivityAt: i.lastActivityAt ?? CATALOG_NOW,
      ...(i.title !== undefined ? { title: i.title } : {}),
    })),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  })
}

/** A server transcript parsed through the real RPC client and wire parser. */
export async function serverSessionMessages(
  agent: string,
  chatId: string,
  fields: Partial<Pick<SessionMessagesResult, 'state' | 'totalTurns'>> = {}
): Promise<SessionMessagesResult> {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ agent, chatId, state: 'idle', turns: [], ...fields }),
  } as Response)
  try {
    return await new RpcProxyClient().loadSessionMessages('test-token', 'test-host', agent, chatId)
  } finally {
    fetchMock.mockRestore()
  }
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
