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
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import type { TaskProgressStreamEvent } from '../../../../../src/types'

type ProgressHandler = (event: TaskProgressStreamEvent) => void | Promise<void>

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
  const messagesByChat = new Map<string, unknown[]>()
  const progressHandlers = new Map<string, ProgressHandler>()

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

  return { invokeHostMessage, progressHandlers }
}

function AgentChatHarness() {
  const vm = useAgentChatController({
    selectedAgent: 'trader',
    agentNames: ['trader'],
    currentTeamId: 'team-1',
    currentTeamName: 'Team One',
    isAuthenticated: true,
    navItem: 'chat',
    pushToast: vi.fn(),
    pushNotification: vi.fn(),
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
      {vm.chatList.map((chat, index) => (
        <button key={chat.id} type="button" onClick={() => void vm.handleSelectChat(chat.id)}>
          Select chat {index + 1}
        </button>
      ))}
    </div>
  )
}

describe('useAgentChatController (cross-chat, migrated)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetComposerDraftStore()
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
    expect(getDraftInputValue()).toBe('')

    fireEvent.change(screen.getByTestId('draft-input'), {
      target: { value: 'draft for session B' },
    })
    expect(getDraftInputValue()).toBe('draft for session B')

    fireEvent.click(screen.getByRole('button', { name: 'Select chat 1' }))
    await waitFor(() => expect(screen.getByTestId('active-chat-id').textContent).toBe(firstChatId))
    expect(getDraftInputValue()).toBe('draft for session A')

    fireEvent.click(screen.getByRole('button', { name: 'Select chat 2' }))
    await waitFor(() =>
      expect(screen.getByTestId('active-chat-id').textContent).not.toBe(firstChatId)
    )
    expect(getDraftInputValue()).toBe('draft for session B')
  })
})
