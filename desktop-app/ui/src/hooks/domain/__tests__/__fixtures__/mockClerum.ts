import { vi } from 'vitest'

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
type Fn = ReturnType<typeof vi.fn>

interface ChatMock {
  list: Fn
  create: Fn
  rename: Fn
  delete: Fn
  loadMessages: Fn
  appendMessages: Fn
  replaceMessages: Fn
  markUnreadTerminal: Fn
  clearUnreadTerminal: Fn
  getLastActive: Fn
  setLastActive: Fn
  getIndex: Fn
  dismissOnboarding: Fn
}

interface RpcMock {
  invokeHostMessage: Fn
  getTaskResult: Fn
  listSessions: Fn
  loadSessionMessages: Fn
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
}

export function installMockClerum(): MockClerum {
  const progressHandlers = new Map<string, Handler>()
  const activityHandlers = new Map<string, Handler>()

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
    delete: vi.fn(async () => undefined),
    loadMessages: vi.fn(async () => []),
    appendMessages: vi.fn(async () => undefined),
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
    dismissOnboarding: vi.fn(async () => undefined),
  }

  const rpc = {
    invokeHostMessage: vi.fn(async () => ({ taskId: 'task-default' })),
    getTaskResult: vi.fn(async () => ({ response: 'ok' })),
    listSessions: vi.fn(async () => ({ items: [] })),
    loadSessionMessages: vi.fn(async () => ({ agent: '', chatId: '', turns: [] })),
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
