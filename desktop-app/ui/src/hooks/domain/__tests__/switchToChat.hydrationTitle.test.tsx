// @vitest-environment jsdom
/**
 * #1091 A20 — opening a server-only chat whose history starts at turn 1. The
 * index holds the server's title when one is known (A19), so that title stays
 * in the sidebar and the Latest list; the first user message names the chat
 * only while it has no title ('New Chat'). Every case runs for a stateful and
 * a stateless Host: the renderer has no branch by Host kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import { localIndex, serverSessions } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOSTS = ['chatllm', 'chatllm-stateless'] as const
const CHAT_ID = 'from-server'
const FIRST_MESSAGE = 'first message typed by the user'

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetComposerDraftStore()
  uninstallMockClerum()
})

/**
 * A server-only chat, listed by the catalog with `serverTitle`, hydrated with
 * `indexTitle` (what `ChatStore.createChat` returns: the remembered server
 * title, else 'New Chat'), and a history that starts at turn 1.
 */
async function openServerOnlyChat(
  host: string,
  serverTitle: string | undefined,
  indexTitle: string
) {
  clerum.chat.getIndex.mockResolvedValue(localIndex([]))
  clerum.rpc.listSessions.mockResolvedValue(
    serverSessions([{ agent: host, chatId: CHAT_ID, title: serverTitle }])
  )
  const createChat = clerum.chat.create.getMockImplementation()
  if (!createChat) throw new Error('mockClerum chat.create has no implementation')
  clerum.chat.create.mockImplementation(async (agentRef: string, chatId: string) => ({
    ...(await createChat(agentRef, chatId)),
    title: indexTitle,
  }))
  clerum.chat.loadMessages.mockResolvedValue([])
  clerum.rpc.loadSessionMessages.mockResolvedValue({
    agent: host,
    chatId: CHAT_ID,
    state: 'idle',
    oldestTurnNumber: 1,
    latestTurnNumber: 1,
    hasMoreBefore: false,
    hasMoreAfter: false,
    turns: [
      {
        number: 1,
        user_input: FIRST_MESSAGE,
        response: 'reply',
        started_at: '2026-05-28T10:01:00Z',
        completed_at: '2026-05-28T10:01:05Z',
      },
    ],
  })

  const controller = renderController({ selectedAgent: host, agentNames: [host] })
  await waitFor(() =>
    expect(controller.result.current.latestChatSessions.some(chat => chat.id === CHAT_ID)).toBe(
      true
    )
  )
  await act(async () => {
    await controller.result.current.switchToChat(host, CHAT_ID)
  })

  // Witness: the hydration ran — the chat was created in the index and its
  // turn-1 history is the visible transcript.
  expect(clerum.chat.create).toHaveBeenCalledWith(host, CHAT_ID)
  expect(controller.result.current.activeChatId).toBe(CHAT_ID)
  expect(controller.result.current.chatMessages.map(message => message.content)).toContain(
    FIRST_MESSAGE
  )
  return controller
}

const sidebarTitle = (controller: Awaited<ReturnType<typeof openServerOnlyChat>>) =>
  controller.result.current.chatList.find(chat => chat.id === CHAT_ID)?.title
const latestTitle = (controller: Awaited<ReturnType<typeof openServerOnlyChat>>) =>
  controller.result.current.latestChatSessions.find(chat => chat.id === CHAT_ID)?.title

describe('hydration title of a server-only chat (#1091 A20)', () => {
  it.each(HOSTS)('%s: keeps the server title instead of the first message', async host => {
    const controller = await openServerOnlyChat(host, 'Server title', 'Server title')

    expect(sidebarTitle(controller)).toBe('Server title')
    expect(latestTitle(controller)).toBe('Server title')
  })

  it.each(HOSTS)('%s: names an untitled chat after its first message', async host => {
    const controller = await openServerOnlyChat(host, undefined, 'New Chat')

    expect(sidebarTitle(controller)).toBe(FIRST_MESSAGE)
    expect(latestTitle(controller)).toBe(FIRST_MESSAGE)
  })
})
