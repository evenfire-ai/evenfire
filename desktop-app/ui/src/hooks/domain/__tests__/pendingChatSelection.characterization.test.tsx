// @vitest-environment jsdom
/**
 * Characterization tests for the agent-selection effect that consumes
 * `pendingChatSelectionByAgentRef` (latest / none / specific). Includes the B9
 * fix: a `specific` selection that never materialises in the merged list must
 * clear the chat spinner (empty-state) instead of spinning forever.
 *
 * See .specs/refactor-useAgentChatController/plan.md Fase 0 + spec.md B.4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

const chatMeta = (id: string, title = id) => ({
  id,
  title,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  messageCount: 1,
})

describe('pendingChatSelection effect', () => {
  it('latest → switches to the most recent chat', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [chatMeta('c-latest')],
    })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', null, { selectLatest: true })
    })
    // Re-run the selection effect by flipping navItem.
    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    await waitFor(() => expect(result.current.activeChatId).toBe('c-latest'))
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'c-latest')
  })

  it('none → selects nothing and clears the spinner', async () => {
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', null, { suppressAutoSelect: true })
    })
    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    await waitFor(() => expect(result.current.chatMessagesLoading).toBe(false))
    expect(result.current.activeChatId).toBeNull()
  })

  it('specific (found) → switches to the requested chat', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [chatMeta('c-specific', 'Specific chat')],
    })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', 'c-specific', { title: 'Specific chat' })
    })
    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'c-specific'
      )
    )
    await waitFor(() => expect(result.current.activeChatId).toBe('c-specific'))
    expect(result.current.chatMessagesLoading).toBe(false)
  })

  it('B9: specific (not found) clears the spinner instead of spinning forever', async () => {
    // A server-only chat surfaced by a notification while listSessions silently
    // returns items:[] — the requested chat never appears in the merged list.
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    clerum.rpc.listSessions.mockResolvedValue({ items: [] })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', 'c-missing', { title: 'Missing' })
    })
    // Optimistic set turns the spinner on for the requested chat.
    expect(result.current.activeChatId).toBe('c-missing')
    expect(result.current.chatMessagesLoading).toBe(true)

    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    // The chat never materialised → no switchToChat reconcile fired for it, and
    // the spinner is cleared (empty-state) rather than left spinning forever.
    await waitFor(() => expect(result.current.chatMessagesLoading).toBe(false))
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-missing'
    )
  })
})
