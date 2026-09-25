// @vitest-environment jsdom
/**
 * Migrated from `hooks/__tests__/useAgentChatController.test.tsx` (the duplicate
 * harness merged into the domain suite — spec.md B18). Preserves the two cases
 * that only lived there: concurrent cross-chat sends and per-chat composer drafts.
 * These use a rendered-component harness (not `renderController`) because they
 * exercise `useComposerDraft` alongside the controller.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useAgentChatController } from '@hooks/domain/useAgentChatController'
import { useComposerDraft } from '@hooks/useComposerDraft'
import { getComposerDraft, resetComposerDraftStore } from '@lib/composerDraftStore'
import type { TaskProgressStreamEvent } from '../../../../../src/types'

type ProgressHandler = (event: TaskProgressStreamEvent) => void | Promise<void>
const revokedAgents = new Set<string>()
const uncertainAgents = new Set<string>()
const onHostAccessRevoked = (agentRef: string) => {
  revokedAgents.add(agentRef)
}
const onHostAuthorityUncertain = (agentRef: string) => {
  uncertainAgents.add(agentRef)
}
const isHostAccessBlocked = (agentRef: string) =>
  revokedAgents.has(agentRef) || uncertainAgents.has(agentRef)
const getHostAuthorityEpoch = () => 0

function getDraftInputValue(): string {
  return (screen.getByTestId('draft-input') as HTMLInputElement).value
}

function createChatMeta(chatId: string) {
  const now = new Date().toISOString()
  return {
    id: chatId,
    title: 'New Chat',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }
}

function installClerumHarness() {
  let taskIndex = 0
  const chats: Array<ReturnType<typeof createChatMeta>> = []
  const deletedChatIds = new Set<string>()
  const messagesByChat = new Map<string, unknown[]>()
  const progressHandlers = new Map<string, ProgressHandler>()
  const loadSessionMessages = vi.fn(async () => ({ agent: 'trader', chatId: '', turns: [] }))
  const listSessions = vi.fn(async () => ({ items: [] }))
  const appendMessages = vi.fn(async (_agentRef: string, chatId: string, messages: unknown[]) => {
    messagesByChat.set(chatId, [...(messagesByChat.get(chatId) || []), ...messages])
  })

  const invokeHostMessage = vi.fn(async (_agentRef: string, _payload: { threadId?: string }) => {
    taskIndex += 1
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
          deletedChatIds.delete(chatId)
          chats.push(meta)
          messagesByChat.set(chatId, [])
          return meta
        }),
        rename: vi.fn(async () => undefined),
        getBindingGeneration: vi.fn(async () => 1),
        captureDeleteFence: vi.fn(async (authorityScope: unknown) => ({
          version: 1,
          authorityScope,
          bindingGeneration: 1,
          sessionGeneration: 1,
        })),
        delete: vi.fn(async (_agentRef: string, chatId: string) => {
          deletedChatIds.add(chatId)
          const index = chats.findIndex(chat => chat.id === chatId)
          if (index >= 0) chats.splice(index, 1)
          messagesByChat.delete(chatId)
          return { cleanupPending: false }
        }),
        loadMessages: vi.fn(
          async (_agentRef: string, chatId: string) => messagesByChat.get(chatId) || []
        ),
        appendMessages,
        replaceMessages: vi.fn(async (_agentRef: string, chatId: string, messages: unknown[]) => {
          messagesByChat.set(chatId, [...messages])
        }),
        markUnreadTerminal: vi.fn(async () => undefined),
        clearUnreadTerminal: vi.fn(async () => undefined),
        getLastActive: vi.fn(async () => null),
        setLastActive: vi.fn(async () => undefined),
        getIndex: vi.fn(async () => ({ chats, deletedChatIds: [...deletedChatIds] })),
        dismissOnboarding: vi.fn(async () => undefined),
      },
      rpc: {
        listSessions,
        loadSessionMessages,
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

  return {
    invokeHostMessage,
    appendMessages,
    progressHandlers,
    loadSessionMessages,
    listSessions,
    seedMessage: (chatId: string, content: string) =>
      messagesByChat.set(chatId, [
        { id: `message-${chatId}`, role: 'user', content, createdAt: new Date().toISOString() },
      ]),
  }
}

function AgentChatHarness() {
  const [selectionState, setSelectionState] = React.useState('idle')
  const [sendState, setSendState] = React.useState('idle')
  const vm = useAgentChatController({
    selectedAgent: 'trader',
    agentNames: ['trader'],
    currentTeamId: 'team-1',
    currentEnvironmentKey: 'env-test',
    currentTeamName: 'Team One',
    isAuthenticated: true,
    loadMenuData: true,
    navItem: 'chat',
    onHostAccessRevoked,
    onHostAuthorityUncertain,
    isHostAccessBlocked,
    getHostAuthorityEpoch,
    pushToast: vi.fn(),
    pushNotification: vi.fn(),
    agentDisplayName: (agentName: string) => agentName,
    canDeliverChatResponseNotification: vi.fn(() => false),
    showDesktopNotification: vi.fn(async () => 'unsupported' as const),
    openAgentConversationFromNotification: vi.fn(async () => undefined),
    decideApprovalFromNotification: vi.fn(async () => undefined),
  })

  // Drafts moved out of the controller into the composer draft store,
  // keyed per chat — subscribe the same way ComposerPanel does.
  const [draft, setDraft] = useComposerDraft(vm.activeChatId)

  return (
    <div>
      <div data-testid="active-chat-id">{vm.activeChatId || ''}</div>
      <div data-testid="agent-sending">{String(vm.agentSending)}</div>
      <div data-testid="chat-message-count">{vm.chatMessages.length}</div>
      <div data-testid="chat-list-ids">{vm.chatList.map(chat => chat.id).join(',')}</div>
      <div data-testid="latest-list-ids">
        {vm.latestChatSessions.map(chat => chat.id).join(',')}
      </div>
      <div data-testid="selection-state">{selectionState}</div>
      <div data-testid="send-state">{sendState}</div>
      <input
        data-testid="draft-input"
        value={draft}
        onChange={event => setDraft(event.target.value)}
      />
      <button type="button" onClick={() => void vm.handleCreateChat()}>
        Create chat
      </button>
      <button
        type="button"
        onClick={() => {
          setSendState('pending')
          void vm.handleSendAgentMessage('hello').then(() => setSendState('settled'))
        }}
      >
        Send message
      </button>
      {vm.chatList.map(chat => (
        <React.Fragment key={chat.id}>
          <button
            type="button"
            onClick={() => {
              setSelectionState('pending')
              void vm.handleSelectChat(chat.id).then(() => setSelectionState('settled'))
            }}
          >
            Select chat {chat.id}
          </button>
          <button
            type="button"
            onClick={() => {
              void vm
                .captureChatDeleteFence('trader')
                .then(deletion => vm.handleDeleteChatForAgent('trader', chat.id, deletion))
            }}
          >
            Delete chat {chat.id}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

describe('useAgentChatController (cross-chat, migrated)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    uncertainAgents.clear()
    resetComposerDraftStore()
    revokedAgents.clear()
    delete (window as { clerum?: unknown }).clerum
  })

  it('allows a second chat session to send while the first session is still in flight', async () => {
    const { invokeHostMessage, progressHandlers } = installClerumHarness()

    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
    const firstChatId = screen.getByTestId('active-chat-id').textContent || ''

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(progressHandlers.has('task-1')).toBe(true))
    await progressHandlers.get('task-1')?.({ type: 'open' } as TaskProgressStreamEvent)

    // The first chat has a task in flight (tracked) — the per-(agent, chat)
    // re-entry guard makes another send to the SAME chat a no-op. (agentSending
    // only covers the synchronous send setup now; in-flight state lives in the
    // tracker, so the guard is what proves "still in flight".)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(invokeHostMessage).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() =>
      expect(screen.getByTestId('active-chat-id').textContent).not.toBe(firstChatId)
    )
    const secondChatId = screen.getByTestId('active-chat-id').textContent || ''

    // …but a different chat CAN send while the first is still streaming.
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(2))

    expect(invokeHostMessage.mock.calls[0]?.[1]).toMatchObject({ threadId: firstChatId })
    expect(invokeHostMessage.mock.calls[1]?.[1]).toMatchObject({ threadId: secondChatId })

    await waitFor(() => expect(progressHandlers.has('task-2')).toBe(true))
    await progressHandlers.get('task-2')?.({ type: 'open' } as TaskProgressStreamEvent)
    await progressHandlers.get('task-1')?.({
      type: 'terminal',
      data: { status: 'completed' },
    } as TaskProgressStreamEvent)
    await progressHandlers.get('task-2')?.({
      type: 'terminal',
      data: { status: 'completed' },
    } as TaskProgressStreamEvent)
    // Terminal → tracker unsubscribes both streams (the mock unsub deletes its
    // handler), proving the tasks were retired.
    await waitFor(() => expect(progressHandlers.size).toBe(0))
  })

  it('keeps composer drafts scoped to their chat session', async () => {
    installClerumHarness()

    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
    const firstChatId = screen.getByTestId('active-chat-id').textContent || ''

    fireEvent.change(screen.getByTestId('draft-input'), {
      target: { value: 'draft for session A' },
    })
    expect(getDraftInputValue()).toBe('draft for session A')

    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() =>
      expect(screen.getByTestId('active-chat-id').textContent).not.toBe(firstChatId)
    )
    const secondChatId = screen.getByTestId('active-chat-id').textContent || ''
    expect(secondChatId).not.toBe('')
    expect(getDraftInputValue()).toBe('')

    fireEvent.change(screen.getByTestId('draft-input'), {
      target: { value: 'draft for session B' },
    })
    expect(getDraftInputValue()).toBe('draft for session B')

    fireEvent.click(screen.getByRole('button', { name: `Select chat ${firstChatId}` }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).toBe(firstChatId))
    expect(getDraftInputValue()).toBe('draft for session A')

    fireEvent.click(screen.getByRole('button', { name: `Select chat ${secondChatId}` }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).toBe(secondChatId))
    expect(getDraftInputValue()).toBe('draft for session B')
  })

  it.each(['404', '503', 'timeout'])(
    'keeps chat, selection and draft after a transient transcript %s',
    async failure => {
      const { loadSessionMessages, seedMessage } = installClerumHarness()
      render(
        <AgentTaskTrackerProvider>
          <AgentChatHarness />
        </AgentTaskTrackerProvider>
      )

      fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
      await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
      const firstChatId = screen.getByTestId('active-chat-id').textContent || ''
      seedMessage(firstChatId, 'known conversation turn')
      fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
      await waitFor(() =>
        expect(screen.getByTestId('active-chat-id').textContent).not.toBe(firstChatId)
      )
      fireEvent.click(screen.getByRole('button', { name: `Select chat ${firstChatId}` }))
      await waitFor(() => expect(screen.getByTestId('chat-message-count').textContent).toBe('1'))
      fireEvent.change(screen.getByTestId('draft-input'), {
        target: { value: 'unsent draft' },
      })

      const readsBeforeFault = loadSessionMessages.mock.calls.length
      loadSessionMessages.mockRejectedValue(new Error(failure))
      fireEvent.click(screen.getByRole('button', { name: `Select chat ${firstChatId}` }))
      await waitFor(() =>
        expect(loadSessionMessages.mock.calls.length).toBeGreaterThan(readsBeforeFault)
      )
      await waitFor(() => expect(screen.getByTestId('selection-state').textContent).toBe('settled'))
      await waitFor(() => expect(screen.getByTestId('chat-message-count').textContent).toBe('1'))
      expect(screen.getByTestId('active-chat-id').textContent).toBe(firstChatId)
      expect(screen.getByTestId('chat-message-count').textContent).toBe('1')
      expect(getDraftInputValue()).toBe('unsent draft')
      expect(screen.getByRole('button', { name: `Select chat ${firstChatId}` })).toBeTruthy()
    }
  )

  it('does not restore protected chat or messages when a pending send resolves after revocation', async () => {
    const { invokeHostMessage, loadSessionMessages, progressHandlers } = installClerumHarness()
    let finishInvoke!: (result: { taskId: string; status: string }) => void
    invokeHostMessage.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishInvoke = resolve
        })
    )
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
    const chatId = screen.getByTestId('active-chat-id').textContent || ''
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))

    loadSessionMessages.mockRejectedValue(new Error('403 forbidden: host_access_revoked'))
    fireEvent.click(screen.getByRole('button', { name: `Select chat ${chatId}` }))
    await waitFor(() => expect(revokedAgents.has('trader')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).toBe(''))
    expect(screen.getByTestId('chat-message-count').textContent).toBe('0')

    finishInvoke({ taskId: 'late-task', status: 'pending' })
    await waitFor(() => expect(screen.getByTestId('send-state').textContent).toBe('settled'))
    await waitFor(() => expect(screen.getByTestId('agent-sending').textContent).toBe('false'))
    expect(screen.getByTestId('active-chat-id').textContent).toBe('')
    expect(screen.getByTestId('chat-message-count').textContent).toBe('0')
    expect(screen.queryByRole('button', { name: `Select chat ${chatId}` })).toBeNull()
    expect(progressHandlers.has('late-task')).toBe(false)
  })

  it.each([
    {
      label: '401',
      sendError: '401 unauthorized',
      readError: null,
      revoked: false,
      uncertain: true,
    },
    {
      label: 'exact Host-wide 403',
      sendError: '403 Forbidden: host_access_revoked',
      readError: '503 unavailable',
      revoked: true,
      uncertain: false,
    },
    {
      label: 'generic 403 with readable catalog',
      sendError: '403 missing send scope',
      readError: null,
      revoked: false,
      uncertain: false,
    },
    {
      label: 'generic 403 with denied catalog',
      sendError: '403 missing send scope',
      readError: '403 forbidden',
      revoked: false,
      uncertain: true,
    },
    {
      label: '404',
      sendError: '404 transient',
      readError: null,
      revoked: false,
      uncertain: false,
    },
  ])(
    'send $label applies the transcript authority decision',
    async ({ sendError, readError, revoked, uncertain }) => {
      const { invokeHostMessage, listSessions } = installClerumHarness()
      invokeHostMessage.mockRejectedValueOnce(new Error(sendError))
      render(
        <AgentTaskTrackerProvider>
          <AgentChatHarness />
        </AgentTaskTrackerProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
      await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
      const chatId = screen.getByTestId('active-chat-id').textContent || ''
      if (readError) listSessions.mockRejectedValue(new Error(readError))
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(screen.getByTestId('send-state').textContent).toBe('settled'))
      expect(revokedAgents.has('trader')).toBe(revoked)
      expect(uncertainAgents.has('trader')).toBe(uncertain)
      if (revoked) {
        expect(screen.getByTestId('active-chat-id').textContent).toBe('')
        expect(screen.getByTestId('chat-message-count').textContent).toBe('0')
      } else {
        expect(screen.getByTestId('active-chat-id').textContent).toBe(chatId)
      }
    }
  )

  it('does not republish a confirmed deleted chat after its pending send resolves', async () => {
    const { invokeHostMessage, appendMessages } = installClerumHarness()
    let finishInvoke!: (result: { taskId: string; status: string }) => void
    invokeHostMessage.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishInvoke = resolve
        })
    )
    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))
    const deletedChatId = screen.getByTestId('active-chat-id').textContent || ''
    await waitFor(() =>
      expect(screen.getByTestId('latest-list-ids').textContent).toContain(deletedChatId)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId('draft-input'), {
      target: { value: 'draft to clear on delete' },
    })
    expect(getComposerDraft(deletedChatId)).toBe('draft to clear on delete')

    fireEvent.click(screen.getByRole('button', { name: `Delete chat ${deletedChatId}` }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `Select chat ${deletedChatId}` })).toBeNull()
    )
    expect(getComposerDraft(deletedChatId)).toBe('')
    const writesBeforeLateAck = appendMessages.mock.calls.length

    finishInvoke({ taskId: 'late-deleted-task', status: 'pending' })
    await waitFor(() => expect(screen.getByTestId('send-state').textContent).toBe('settled'))
    expect(screen.getByTestId('chat-list-ids').textContent).not.toContain(deletedChatId)
    expect(screen.getByTestId('latest-list-ids').textContent).not.toContain(deletedChatId)
    expect(getComposerDraft(deletedChatId)).toBe('')
    expect(appendMessages.mock.calls.length).toBe(writesBeforeLateAck)

    const survivingChatId = screen.getByTestId('active-chat-id').textContent || ''
    expect(survivingChatId).not.toBe('')
    expect(survivingChatId).not.toBe(deletedChatId)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(2))
    expect(invokeHostMessage.mock.calls[1]?.[1]).toMatchObject({ threadId: survivingChatId })
  })
})
