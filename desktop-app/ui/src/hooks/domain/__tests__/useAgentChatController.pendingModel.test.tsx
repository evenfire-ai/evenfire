// @vitest-environment jsdom
/**
 * R2 "Option A" send-path piggyback: a per-session model chosen while the host
 * was suspended is held as pending (module-level, in `useChatStore`) and carried
 * on the next `invokeHostMessage` as `model`, then cleared after an authoritative
 * read confirms it. Sends with no pending omit `model` entirely.
 *
 * Harness mirrors `useAgentChatController.crossChat.test.tsx` — a rendered
 * component so the real send path runs — trimmed to a single agent + chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useAgentChatController } from '@hooks/domain/useAgentChatController'
import { useChatStore } from '@hooks/useChatStore'
import { useComposerDraft } from '@hooks/useComposerDraft'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import { resetHostModelSelectionStore } from '@lib/hostModelSelectionStore'
import type { TaskProgressStreamEvent } from '../../../../../src/types'

type ProgressHandler = (event: TaskProgressStreamEvent) => void | Promise<void>

function createChatMeta(chatId: string) {
  const now = new Date().toISOString()
  return { id: chatId, title: 'New Chat', createdAt: now, updatedAt: now, messageCount: 0 }
}

function installClerumHarness() {
  let taskIndex = 0
  const chats: Array<ReturnType<typeof createChatMeta>> = []
  const messagesByChat = new Map<string, unknown[]>()
  const progressHandlers = new Map<string, ProgressHandler>()
  let sessionModel: string | null = null

  const invokeHostMessage = vi.fn(async (_agentRef: string, _payload: { model?: string }) => {
    taskIndex += 1
    sessionModel = _payload.model ?? sessionModel
    return { taskId: `task-${taskIndex}`, status: 'pending' }
  })

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      chat: {
        list: vi.fn(async () => chats),
        create: vi.fn(async (_agentRef: string, chatId: string) => {
          const meta = createChatMeta(chatId)
          chats.push(meta)
          messagesByChat.set(chatId, [])
          return meta
        }),
        rename: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        loadMessages: vi.fn(
          async (_agentRef: string, chatId: string) => messagesByChat.get(chatId) || []
        ),
        appendMessages: vi.fn(async (_agentRef: string, chatId: string, messages: unknown[]) => {
          messagesByChat.set(chatId, [...(messagesByChat.get(chatId) || []), ...messages])
        }),
        replaceMessages: vi.fn(async (_agentRef: string, chatId: string, messages: unknown[]) => {
          messagesByChat.set(chatId, [...messages])
        }),
        markUnreadTerminal: vi.fn(async () => undefined),
        clearUnreadTerminal: vi.fn(async () => undefined),
        getLastActive: vi.fn(async () => null),
        setLastActive: vi.fn(async () => undefined),
        getIndex: vi.fn(async () => ({ chats })),
        dismissOnboarding: vi.fn(async () => undefined),
      },
      rpc: {
        getHostModels: vi.fn(async () => ({
          provider: 'anthropic',
          hostDefault: 'claude-opus-4-8',
          sessionModel,
          degraded: false,
          models: [{ name: 'claude-opus-4-8' }],
          modelSelectionRevision: taskIndex,
        })),
        listSessions: vi.fn(async () => ({ items: [] })),
        loadSessionMessages: vi.fn(async () => ({ agent: 'trader', chatId: '', turns: [] })),
        subscribeHostActivity: vi.fn(async () => async () => undefined),
        invokeHostMessage,
        subscribeTaskProgress: vi.fn(
          async (_hostRef: string, taskId: string, onEvent: ProgressHandler) => {
            progressHandlers.set(taskId, onEvent)
            return async () => {
              progressHandlers.delete(taskId)
            }
          }
        ),
        getTaskResult: vi.fn(async (_hostRef: string, taskId: string) => ({
          response: `${taskId} done`,
        })),
        cancelTask: vi.fn(async () => undefined),
      },
    },
  })

  return { invokeHostMessage }
}

function AgentChatHarness() {
  const vm = useAgentChatController({
    selectedAgent: 'trader',
    agentNames: ['trader'],
    currentTeamId: 'team-1',
    currentTeamName: 'Team One',
    isAuthenticated: true,
    loadMenuData: true,
    navItem: 'chat',
    pushToast: vi.fn(),
    pushNotification: vi.fn(),
    agentDisplayName: (agentName: string) => agentName,
    canDeliverChatResponseNotification: vi.fn(() => false),
    showDesktopNotification: vi.fn(async () => 'unsupported' as const),
    openAgentConversationFromNotification: vi.fn(async () => undefined),
    decideApprovalFromNotification: vi.fn(async () => undefined),
  })
  // Mirror ComposerPanel/crossChat exactly (the send path reads the draft store).
  const [draft, setDraft] = useComposerDraft(vm.activeChatId)

  return (
    <div>
      <div data-testid="active-chat-id">{vm.activeChatId || ''}</div>
      <div data-testid="agent-sending">{String(vm.agentSending)}</div>
      <input
        data-testid="draft-input"
        value={draft}
        onChange={event => setDraft(event.target.value)}
      />
      <button type="button" onClick={() => void vm.handleCreateChat()}>
        Create chat
      </button>
      <button type="button" onClick={() => void vm.handleSendAgentMessage('hello')}>
        Send message
      </button>
    </div>
  )
}

async function createChat() {
  fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
  await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
  return screen.getByTestId('active-chat-id').textContent || ''
}

/**
 * Read/write the module-level pending store (a `useChatStore` singleton) from
 * outside the harness — keeps the rendered component identical to the clean
 * crossChat harness so the controller render loop stays stable.
 */
function setPending(chatId: string, model: string): void {
  const { result, unmount } = renderHook(() => useChatStore())
  result.current.setPendingModel('trader', chatId, model)
  unmount()
}
function readPending(chatId: string): string | undefined {
  const { result, unmount } = renderHook(() => useChatStore())
  const value = result.current.getPendingModel('trader', chatId)
  unmount()
  return value
}
function setPreChat(model: string): void {
  const { result, unmount } = renderHook(() => useChatStore())
  result.current.setPreChatModel('trader', model)
  unmount()
}
function readPreChat(): string | undefined {
  const { result, unmount } = renderHook(() => useChatStore())
  const value = result.current.getPreChatModel('trader')
  unmount()
  return value
}

describe('useAgentChatController — R2 "Option A" pending-model piggyback', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetComposerDraftStore()
    // The send path now writes revisions into the selection store, so its entries
    // must not survive into the next test.
    resetHostModelSelectionStore()
    delete (window as { clerum?: unknown }).clerum
  })

  it('(d) includes the pending model and clears it after the host confirms selection', async () => {
    const { invokeHostMessage } = installClerumHarness()
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    const chatId = await createChat()
    setPending(chatId, 'claude-opus-4-8')
    expect(readPending(chatId)).toBe('claude-opus-4-8')

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))

    // The piggybacked model rode along with this send.
    expect(invokeHostMessage.mock.calls[0]?.[1]).toMatchObject({
      threadId: chatId,
      model: 'claude-opus-4-8',
    })
    // The fresh host projection confirms persistence, not just HTTP acceptance.
    await waitFor(() => expect(readPending(chatId)).toBeUndefined())
  })

  it('does not invent a Codex catalog default when sending without a pending model', async () => {
    const { invokeHostMessage } = installClerumHarness()
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    await createChat()
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))

    const payload = invokeHostMessage.mock.calls[0]?.[1] as Record<string, unknown>
    expect('model' in payload).toBe(false)
  })

  // #654 L8 — contract change. An ack that carries `modelSelectionRevision` means
  // "your piggybacked model is persisted"; a successful ack WITHOUT it, after a
  // piggyback was sent, means the Host ignored the model. Keeping the intent there
  // (the previous behaviour) re-sent a pick the Host refuses on every subsequent
  // message and left the chip promising a model the session never had.
  it('drops the pending choice when the host acknowledges the send without a revision', async () => {
    const { invokeHostMessage } = installClerumHarness()
    const getHostModels = vi.spyOn(window.clerum.rpc, 'getHostModels').mockResolvedValue({
      provider: 'anthropic',
      hostDefault: 'claude-opus-4-8',
      sessionModel: null,
      degraded: false,
      models: [{ name: 'claude-opus-4-8' }],
      modelSelectionRevision: 0,
    })
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )
    const chatId = await createChat()
    setPending(chatId, 'claude-opus-4-8')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))
    // Witnesses: the piggyback did ride along, and the confirmation read did run —
    // so the drop below is a decision the path made, not a path that never ran.
    expect(invokeHostMessage.mock.calls[0]?.[1]).toMatchObject({
      threadId: chatId,
      model: 'claude-opus-4-8',
    })
    await waitFor(() => expect(getHostModels).toHaveBeenCalled())
    await waitFor(() => expect(readPending(chatId)).toBeUndefined())
  })

  // The complement of the L8 drop: a send that never reached the Host says nothing
  // about the model, so the pick must survive for the retry.
  it('keeps the pending choice when the POST itself fails', async () => {
    const { invokeHostMessage } = installClerumHarness()
    invokeHostMessage.mockRejectedValueOnce(new Error('offline'))
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )
    const chatId = await createChat()
    setPending(chatId, 'claude-opus-4-8')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('agent-sending').textContent).toBe('false'))
    expect(readPending(chatId)).toBe('claude-opus-4-8')
  })

  it('(e) omits model entirely when there is no pending selection', async () => {
    const { invokeHostMessage } = installClerumHarness()
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    await createChat()
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))

    const payload = invokeHostMessage.mock.calls[0]?.[1] as Record<string, unknown>
    expect('model' in payload).toBe(false)
  })

  it('(f) migrates a PRE-CHAT model pick onto the first send that auto-creates the chat', async () => {
    const { invokeHostMessage } = installClerumHarness()
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    // The user picked a model on the NEW-CHAT composer (no chat exists yet), so it
    // lives in the agent-keyed pre-chat slot with no chatId.
    setPreChat('claude-opus-4-8')
    expect(readPreChat()).toBe('claude-opus-4-8')

    // Send WITHOUT creating a chat first — this send auto-creates the chatId.
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))
    const chatId = screen.getByTestId('active-chat-id').textContent || ''
    expect(chatId).not.toBe('')

    // The pre-chat pick rode along on message 1 of the brand-new chat…
    expect(invokeHostMessage.mock.calls[0]?.[1]).toMatchObject({
      threadId: chatId,
      model: 'claude-opus-4-8',
    })
    // …the pre-chat slot was consumed (no stale carry-over to the next new chat)…
    expect(readPreChat()).toBeUndefined()
    // The migrated pending slot drains after the authoritative read confirms it.
    await waitFor(() => expect(readPending(chatId)).toBeUndefined())
  })
})
