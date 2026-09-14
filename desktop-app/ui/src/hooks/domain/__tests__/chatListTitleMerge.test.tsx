// @vitest-environment jsdom
/**
 * spec 15 §2.2 — the session-title precedence merge, asserted through the
 * observable sidebar output (pr-discipline T4: assert the title the user sees,
 * not an intermediate effect). Covers cases A–D of the decision table for the
 * agent-scoped chat list, plus the cross-agent "Latest sessions" placeholder.
 *
 * T1: the server-side `listSessions` payloads are run through the REAL wire
 * parser (`parseSessionsListResult`) before being handed to the IPC mock, so the
 * fixtures are derived from the producer instead of hand-built parsed shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { parseSessionsListResult } from '../../../../../src/rpcProxyClient'
import type { ChatIndex, SessionsListResult } from '../../../../../src/types'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

const NOW = '2026-09-12T00:00:00.000Z'

/** Parse a raw wire payload through the real producer parser (T1). */
function serverSessions(
  items: Array<{ agent: string; chatId: string; title?: string }>
): SessionsListResult {
  return parseSessionsListResult({
    items: items.map(i => ({
      agent: i.agent,
      chatId: i.chatId,
      turnCount: 1,
      lastActivityAt: NOW,
      ...(i.title !== undefined ? { title: i.title } : {}),
    })),
  })
}

function localIndex(chats: Array<{ id: string; title: string }>): ChatIndex {
  return {
    version: 1,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: chats.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: NOW,
      updatedAt: NOW,
      messageCount: 0,
    })),
  }
}

describe('chat list title merge (spec 15 §2.2, cases A–D)', () => {
  it('case A: server-only session with a title shows the server title (no placeholder)', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-a', title: 'Deploy staging' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() =>
      expect(result.current.chatList.find(c => c.id === 'chat-a')?.title).toBe('Deploy staging')
    )
  })

  it('case B: server-only session with no title shows the "Chat <id>" placeholder', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-bcdef012345' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() =>
      expect(result.current.chatList.find(c => c.id === 'chat-bcdef012345')?.title).toBe(
        'Chat chat-bcd'
      )
    )
  })

  it('case C: cached session + server title -> server wins (picks up a rename from another device)', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'chat-c', title: 'old local name' }]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-c', title: 'renamed on device B' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() =>
      expect(result.current.chatList.find(c => c.id === 'chat-c')?.title).toBe(
        'renamed on device B'
      )
    )
  })

  it('case D: cached session + server sends no title -> local fallback survives', async () => {
    clerum.chat.getIndex.mockResolvedValue(
      localIndex([{ id: 'chat-d', title: 'my local only name' }])
    )
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-d' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    // Wait until the server catalog has been merged (the entry is present), then
    // confirm the local title was NOT clobbered by a placeholder.
    await waitFor(() => expect(result.current.chatList.some(c => c.id === 'chat-d')).toBe(true))
    expect(result.current.chatList.find(c => c.id === 'chat-d')?.title).toBe('my local only name')
  })
})

describe('cross-agent "Latest sessions" title merge (spec 15 §2.2)', () => {
  it('case A: server title on a cross-agent session replaces the "Remote ·" placeholder', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? serverSessions([{ agent: 'agent-y', chatId: 'chat-y', title: 'Cross-device title' }])
        : serverSessions([])
    )

    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
    })

    await waitFor(() =>
      expect(
        result.current.latestChatSessions.find(s => s.agentRef === 'agent-y' && s.id === 'chat-y')
          ?.title
      ).toBe('Cross-device title')
    )
  })

  it('case B: no server title on a cross-agent session shows the "Remote ·" placeholder', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? serverSessions([{ agent: 'agent-y', chatId: 'chat-yabcdef01' }])
        : serverSessions([])
    )

    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
    })

    await waitFor(() =>
      expect(
        result.current.latestChatSessions.find(
          s => s.agentRef === 'agent-y' && s.id === 'chat-yabcdef01'
        )?.title
      ).toBe('Remote · chat-yab')
    )
  })
})
