import { type Mock, vi } from 'vitest'

/**
 * D.0 characterization fixture — installs a fake `window.clerum` bridge.
 *
 * Deviation from D0 plan §5.2: instead of `vi.mock('../../useChatStore')`, we
 * inject `window.clerum.{chat,rpc}` directly (the established repo pattern, see
 * `useAppController.test.tsx`). `useChatStore` is a thin wrapper over
 * `window.clerum.chat.*` / `window.clerum.rpc.*`, so this exercises the real
 * hook code path and keeps the suite consistent with the rest of the repo.
 */

type Handler = (event: unknown) => void
// `ReturnType<typeof vi.fn>` resolves to `Mock<Procedure | Constructable>`, and
// that union does not satisfy `(...args: any) => any`. Callers here write
// `Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>` to name a bridge
// result type, which needs a member that is a call signature and nothing else.
type Fn = Mock<(...args: any[]) => any>

interface ChatMock {
  list: Fn
  create: Fn
  rename: Fn
  getBindingGeneration: Fn
  captureDeleteFence: Fn
  delete: Fn
  loadMessages: Fn
  appendMessages: Fn
  upsertMessages: Fn
  replaceMessages: Fn
  markUnreadTerminal: Fn
  clearUnreadTerminal: Fn
  getLastActive: Fn
  setLastActive: Fn
  getIndex: Fn
  reconcileServerSessions: Fn
  dismissOnboarding: Fn
}

interface RpcMock {
  invokeHostMessage: Fn
  getTaskResult: Fn
  listSessions: Fn
  loadSessionMessages: Fn
  renameSession: Fn
  getContextBreakdown: Fn
  cancelTask: Fn
  subscribeHostActivity: Fn
  subscribeTaskProgress: Fn
  subscribeHostStatus: Fn
}

export interface MockClerum {
  chat: ChatMock
  rpc: RpcMock
  /** Fire a task-progress SSE event to the handler registered for `taskId`. */
  emitTaskProgress: (taskId: string, event: unknown) => void
  /** Fire a host-activity SSE event to the handler registered for `hostRef`. */
  emitActivity: (hostRef: string, event: unknown) => void
  /** True once a progress handler exists for `taskId`. */
  hasProgressHandler: (taskId: string) => boolean
  /** True once an activity handler exists for `hostRef`. */
  hasActivityHandler: (hostRef: string) => boolean
  /** What the fake store holds for one chat after append/upsert writes. */
  persistedMessages: (agentRef: string, chatId: string) => Array<Record<string, unknown>>
}

export function installMockClerum(): MockClerum {
  const progressHandlers = new Map<string, Handler>()
  const activityHandlers = new Map<string, Handler>()
  // What the fake store holds per chat, so `upsertMessages` can merge like the
  // real `ChatStore.upsertMessages` instead of dropping a second write of an id.
  const persistedByChat = new Map<string, Array<Record<string, unknown>>>()
  const persistedKey = (agentRef: string, chatId: string) => `${agentRef}\u0000${chatId}`
  const persistedIndexOf = (persisted: Array<Record<string, unknown>>, id: string) =>
    persisted.findIndex(message => message.id === id)

  const isoNow = () => new Date().toISOString()

  const chat = {
    list: vi.fn(async () => []),
    create: vi.fn(async (_agentRef: string, chatId: string) => ({
      id: chatId,
      title: 'New Chat',
      createdAt: isoNow(),
      updatedAt: isoNow(),
      messageCount: 0,
    })),
    rename: vi.fn(async () => undefined),
    getBindingGeneration: vi.fn(async () => 1),
    captureDeleteFence: vi.fn(async (authorityScope: unknown) => ({
      version: 1,
      authorityScope,
      bindingGeneration: 1,
      sessionGeneration: 1,
    })),
    delete: vi.fn(async () => ({ cleanupPending: false })),
    loadMessages: vi.fn(async () => []),
    appendMessages: vi.fn(async (agentRef: string, chatId: string, messages: unknown[]) => {
      const key = persistedKey(agentRef, chatId)
      persistedByChat.set(key, [
        ...(persistedByChat.get(key) ?? []),
        ...(messages as Array<Record<string, unknown>>),
      ])
    }),
    /**
     * Mirrors `ChatStore.upsertMessages` (src/chatStore.ts, the id branch of
     * `mergeReconciledMessages`): per chat, an id already persisted is replaced
     * in place and keeps its existing `task_id`; a new id is appended. New ids
     * still go through `appendMessages` so suites that count persisted turns
     * keep observing them there.
     */
    upsertMessages: vi.fn(async (agentRef: string, chatId: string, messages: unknown[]) => {
      const key = persistedKey(agentRef, chatId)
      const persisted = persistedByChat.get(key) ?? []
      const unseen: Array<Record<string, unknown>> = []
      for (const message of messages as Array<Record<string, unknown>>) {
        const id = message.id
        if (typeof id !== 'string') {
          throw new Error(`mockClerum.upsertMessages: message without a string id in ${chatId}`)
        }
        const index = persistedIndexOf(persisted, id)
        if (index < 0) {
          const pending = persistedIndexOf(unseen, id)
          if (pending < 0) unseen.push(message)
          else unseen[pending] = message
          continue
        }
        const taskId = persisted[index]?.task_id ?? message.task_id
        persisted[index] = { ...message, ...(taskId !== undefined ? { task_id: taskId } : {}) }
      }
      persistedByChat.set(key, persisted)
      if (unseen.length) await chat.appendMessages(agentRef, chatId, unseen)
    }),
    replaceMessages: vi.fn(async () => undefined),
    markUnreadTerminal: vi.fn(async () => undefined),
    clearUnreadTerminal: vi.fn(async () => undefined),
    getLastActive: vi.fn(async () => null),
    setLastActive: vi.fn(async () => undefined),
    getIndex: vi.fn(async () => ({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })),
    reconcileServerSessions: vi.fn(async () => 0),
    dismissOnboarding: vi.fn(async () => undefined),
  }

  const rpc = {
    invokeHostMessage: vi.fn(async () => ({ taskId: 'task-default' })),
    getTaskResult: vi.fn(async () => ({ response: 'ok' })),
    listSessions: vi.fn(async () => ({ items: [] })),
    loadSessionMessages: vi.fn(async () => ({ agent: '', chatId: '', turns: [] })),
    renameSession: vi.fn(
      async (_hostRef: string, _agent: string, _chatId: string, title: string) => ({
        title,
      })
    ),
    getContextBreakdown: vi.fn(async () => ({ breakdown: null })),
    cancelTask: vi.fn(async () => undefined),
    subscribeHostActivity: vi.fn(
      async (hostRef: string, _hostRefs: string[] | undefined, onEvent: Handler) => {
        activityHandlers.set(hostRef, onEvent)
        return async () => {
          activityHandlers.delete(hostRef)
        }
      }
    ),
    subscribeTaskProgress: vi.fn(async (_hostRef: string, taskId: string, onEvent: Handler) => {
      progressHandlers.set(taskId, onEvent)
      return async () => {
        progressHandlers.delete(taskId)
      }
    }),
    subscribeHostStatus: vi.fn(async () => async () => undefined),
  }

  const clerum = {
    chat,
    rpc,
    emitTaskProgress(taskId: string, event: unknown) {
      const handler = progressHandlers.get(taskId)
      if (!handler) throw new Error(`No task-progress handler registered for taskId="${taskId}"`)
      handler(event)
    },
    emitActivity(hostRef: string, event: unknown) {
      const handler = activityHandlers.get(hostRef)
      if (!handler) throw new Error(`No host-activity handler registered for hostRef="${hostRef}"`)
      handler(event)
    },
    hasProgressHandler: (taskId: string) => progressHandlers.has(taskId),
    hasActivityHandler: (hostRef: string) => activityHandlers.has(hostRef),
    persistedMessages: (agentRef: string, chatId: string) => [
      ...(persistedByChat.get(persistedKey(agentRef, chatId)) ?? []),
    ],
  }

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: clerum,
  })

  return clerum as unknown as MockClerum
}

export function uninstallMockClerum(): void {
  delete (window as { clerum?: unknown }).clerum
}
