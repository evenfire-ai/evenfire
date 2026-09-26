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
  const chatsByAgent = new Map<string, Array<ReturnType<typeof createChatMeta>>>()
  const deletedChatIds = new Set<string>()
  const messagesByAgentChat = new Map<string, unknown[]>()
  const messageKey = (agentRef: string, chatId: string) => `${agentRef}\u0000${chatId}`
  const progressHandlers = new Map<string, ProgressHandler>()
  const loadSessionMessages = vi.fn(async () => ({ agent: 'trader', chatId: '', turns: [] }))
  const listSessions = vi.fn(async () => ({ items: [] }))
  const appendMessages = vi.fn(async (agentRef: string, chatId: string, messages: unknown[]) => {
    const key = messageKey(agentRef, chatId)
    messagesByAgentChat.set(key, [...(messagesByAgentChat.get(key) || []), ...messages])
  })
  const upsertMessagesIntoMap = (agentRef: string, chatId: string, messages: unknown[]) => {
    const key = messageKey(agentRef, chatId)
    const existing = messagesByAgentChat.get(key) || []
    const byId = new Map(existing.map(message => [(message as { id: string }).id, message]))
    for (const message of messages) byId.set((message as { id: string }).id, message)
    messagesByAgentChat.set(key, [...byId.values()])
  }
  const upsertMessages = vi.fn(async (agentRef: string, chatId: string, messages: unknown[]) => {
    upsertMessagesIntoMap(agentRef, chatId, messages)
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
        list: vi.fn(async (agentRef: string) => chatsByAgent.get(agentRef) || []),
        create: vi.fn(async (_agentRef: string, chatId: string) => {
          const meta = createChatMeta(chatId)
          const agentChats = chatsByAgent.get(_agentRef) || []
          agentChats.push(meta)
          chatsByAgent.set(_agentRef, agentChats)
          messagesByAgentChat.set(messageKey(_agentRef, chatId), [])
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
          const chats = chatsByAgent.get(_agentRef) || []
          const index = chats.findIndex(chat => chat.id === chatId)
          if (index >= 0) chats.splice(index, 1)
          messagesByAgentChat.delete(messageKey(_agentRef, chatId))
          return { cleanupPending: false }
        }),
        loadMessages: vi.fn(
          async (agentRef: string, chatId: string) =>
            messagesByAgentChat.get(messageKey(agentRef, chatId)) || []
        ),
        appendMessages,
        upsertMessages,
        replaceMessages: vi.fn(async (agentRef: string, chatId: string, messages: unknown[]) => {
          messagesByAgentChat.set(messageKey(agentRef, chatId), [...messages])
        }),
        markUnreadTerminal: vi.fn(async () => undefined),
        clearUnreadTerminal: vi.fn(async () => undefined),
        getLastActive: vi.fn(async () => null),
        setLastActive: vi.fn(async () => undefined),
        getIndex: vi.fn(async (agentRef: string) => ({
          chats: chatsByAgent.get(agentRef) || [],
          deletedChatIds: [...deletedChatIds],
        })),
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
    upsertMessages,
    progressHandlers,
    loadSessionMessages,
    listSessions,
    seedMessage: (chatId: string, content: string) =>
      messagesByAgentChat.set(messageKey('trader', chatId), [
        { id: `message-${chatId}`, role: 'user', content, createdAt: new Date().toISOString() },
      ]),
  }
}

function AgentChatHarness() {
  const [selectionState, setSelectionState] = React.useState('idle')
  const [sendState, setSendState] = React.useState('idle')
  const [selectedAgent, setSelectedAgent] = React.useState('trader')
  const vm = useAgentChatController({
    selectedAgent,
    agentNames: ['trader', 'chatllm-stateless'],
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
      {vm.chatMessages.map(message => (
        <div key={message.id} data-testid="chat-message-row">
          {message.content}
        </div>
      ))}
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
      {(['trader', 'chatllm-stateless'] as const).map(agent => (
        <button
          key={agent}
          type="button"
          onClick={() => {
            setSelectedAgent(agent)
          }}
        >
          Select agent {agent}
        </button>
      ))}
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

  it('persists the outgoing row before invoking the host and leaves it visible while the acknowledgement is pending', async () => {
    const { invokeHostMessage, upsertMessages, progressHandlers } = installClerumHarness()
    let acknowledge!: (result: { taskId: string; status: string }) => void
    invokeHostMessage.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          acknowledge = resolve
        })
    )

    render(
      <AgentTaskTrackerProvider>
        <AgentChatHarness />
      </AgentTaskTrackerProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(''))

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))

    expect(upsertMessages.mock.invocationCallOrder[0]).toBeLessThan(
      invokeHostMessage.mock.invocationCallOrder[0]!
    )
    expect(upsertMessages.mock.calls[0]?.[2]?.[0]).toMatchObject({
      role: 'user',
      content: 'hello',
    })
    expect(upsertMessages.mock.calls[0]?.[2]?.[0]).not.toHaveProperty('task_id')
    expect(screen.getByTestId('chat-message-row').textContent).toBe('hello')
    expect(screen.getByTestId('send-state').textContent).toBe('pending')
    expect(progressHandlers.size).toBe(0)

    acknowledge({ taskId: 'acknowledged-task', status: 'pending' })
    await waitFor(() => expect(screen.getByTestId('send-state').textContent).toBe('settled'))
    await waitFor(() => expect(progressHandlers.has('acknowledged-task')).toBe(true))
    expect(upsertMessages.mock.calls[1]?.[2]?.[0]).toMatchObject({
      id: (upsertMessages.mock.calls[0]?.[2]?.[0] as { id: string }).id,
      task_id: 'acknowledged-task',
    })
    expect(screen.getByTestId('chat-message-row').textContent).toBe('hello')

    await progressHandlers.get('acknowledged-task')?.({
      type: 'terminal',
      data: { status: 'completed' },
    } as TaskProgressStreamEvent)
    await waitFor(() => expect(progressHandlers.size).toBe(0))
  })

  it('keeps an outgoing message visible across a Host switch while its POST is pending', async () => {
    const { invokeHostMessage, upsertMessages } = installClerumHarness()
    const persistOutgoingToMap = upsertMessages.getMockImplementation()
    let persistOutgoing!: () => void
    upsertMessages.mockImplementationOnce(
      (agentRef: string, chatId: string, messages: unknown[]) =>
        new Promise(resolve => {
          persistOutgoing = () => {
            persistOutgoingToMap?.(agentRef, chatId, messages)
            resolve(undefined)
          }
        })
    )
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
    await waitFor(() => expect(upsertMessages).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Select agent chatllm-stateless' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).not.toBe(chatId))
    persistOutgoing()
    await waitFor(() => expect(invokeHostMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('chat-message-count').textContent).toBe('0')
    fireEvent.click(screen.getByRole('button', { name: 'Select agent trader' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).toBe(chatId))
    await waitFor(() => expect(screen.getByTestId('chat-message-count').textContent).toBe('1'))

    finishInvoke({ taskId: 'late-task', status: 'pending' })
    await waitFor(() => expect(screen.getByTestId('send-state').textContent).toBe('settled'))
    expect(screen.getByTestId('chat-message-count').textContent).toBe('1')
    expect(upsertMessages).toHaveBeenCalledTimes(2)
    expect(upsertMessages.mock.calls[0]?.[2]?.[0]).toMatchObject({ role: 'user' })
    expect(upsertMessages.mock.calls[0]?.[2]?.[0]).not.toHaveProperty('task_id')
    expect(upsertMessages.mock.calls[1]?.[2]?.[0]).toMatchObject({
      role: 'user',
      task_id: 'late-task',
    })
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
    await waitFor(() =>
      expect(screen.getByTestId('latest-list-ids').textContent).not.toContain(deletedChatId)
    )
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
