// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  type AppUnderTest,
  bootApp,
  createDeferred,
  errorToasts,
  gfsPreview,
  messageIdFor,
  openDrawerOverFiles,
  routeIndexThroughStore,
  seedChats,
  selectInDrawer,
  visibleConversation,
  waitForSettled,
} from '../domain/__tests__/__fixtures__/drawerSelectionFixtures'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The drawer shows a conversation over a non-chat workspace tab. Moving between
 * two non-chat tabs (Files, Preview, Apps picker, Settings) is not a selection,
 * so whatever the drawer shows or is loading must come out the same as if the
 * tab had not changed. Leaving or entering the chat route is a selection
 * boundary and keeps its reset/replay semantics.
 */
describe('useAppController — drawer selection across non-chat tab changes', () => {
  let app: AppUnderTest | null = null
  let clerum: MockClerum

  beforeEach(() => {
    vi.clearAllMocks()
    clerum = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] }).clerum
    routeIndexThroughStore(clerum)
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  const callCount = (fn: { mock: { calls: unknown[] } }) => fn.mock.calls.length

  it('keeps the drawer chat when the Apps picker opens over the Files tab', async () => {
    await seedChats(clerum, 'agent-x', ['x-1'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')

    act(() => {
      app!.result.current.showAppsPicker()
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    await waitForSettled(app)

    expect(visibleConversation(app)).toEqual({
      activeChatId: 'x-1',
      messageIds: [messageIdFor('x-1')],
    })
  })

  it('keeps a chat opened from the sidebar list while the drawer moves Files → Preview', async () => {
    await seedChats(clerum, 'agent-x', ['x-1', 'x-2'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')

    await act(async () => {
      await app!.result.current.handleSelectChat('x-2')
    })
    await waitFor(() =>
      expect(visibleConversation(app!)).toEqual({
        activeChatId: 'x-2',
        messageIds: [messageIdFor('x-2')],
      })
    )

    act(() => {
      app!.result.current.openPreviewSection(gfsPreview())
    })
    await waitForSettled(app)

    expect(visibleConversation(app)).toEqual({
      activeChatId: 'x-2',
      messageIds: [messageIdFor('x-2')],
    })
  })

  it('keeps a same-agent drawer pick of another chat across Files → Preview without reloading the list', async () => {
    await seedChats(clerum, 'agent-x', ['x-1', 'x-2'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')

    selectInDrawer(app, 'agent-x', 'x-2')
    await waitFor(() =>
      expect(visibleConversation(app!)).toEqual({
        activeChatId: 'x-2',
        messageIds: [messageIdFor('x-2')],
      })
    )
    await waitForSettled(app)
    const indexCalls = callCount(clerum.chat.getIndex)

    act(() => {
      app!.result.current.openPreviewSection(gfsPreview())
    })
    await waitForSettled(app)

    expect(visibleConversation(app)).toEqual({
      activeChatId: 'x-2',
      messageIds: [messageIdFor('x-2')],
    })
    expect(callCount(clerum.chat.getIndex)).toBe(indexCalls)
  })

  it('a tab change while another agent’s chat list loads ends as if it had not happened', async () => {
    await seedChats(clerum, 'agent-x', ['x-1'])
    await seedChats(clerum, 'agent-y', ['y-1'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')

    const catalog = createDeferred<Awaited<ReturnType<typeof clerum.readIndex>>>()
    const indexCallsBefore = callCount(clerum.chat.getIndex)
    clerum.chat.getIndex.mockImplementationOnce(() => catalog.promise)
    selectInDrawer(app, 'agent-y', 'y-1')
    await waitFor(() => expect(callCount(clerum.chat.getIndex)).toBe(indexCallsBefore + 1))

    act(() => {
      app!.result.current.openPreviewSection(gfsPreview())
    })
    await act(async () => catalog.resolve(await clerum.readIndex('agent-y')))
    await waitForSettled(app)

    expect(visibleConversation(app)).toEqual({
      activeChatId: 'y-1',
      messageIds: [messageIdFor('y-1')],
    })
    expect(clerum.chat.getIndex.mock.calls.slice(indexCallsBefore)).toEqual([['agent-y']])
    expect(errorToasts(app)).toEqual([])
  })

  describe('a tab change while another agent’s chat is opening', () => {
    async function openAgentYWhileTabChanges(outcome: 'resolve' | 'reject') {
      await seedChats(clerum, 'agent-x', ['x-1'])
      await seedChats(clerum, 'agent-y', ['y-1'])
      app = await bootApp()
      await openDrawerOverFiles(app, 'agent-x', 'x-1')

      const opening = createDeferred<void>()
      clerum.chat.setLastActive.mockImplementation(async (agent: string, chat: string) => {
        if (agent === 'agent-y') return opening.promise
        return clerum.persistLastActive(agent, chat)
      })
      selectInDrawer(app, 'agent-y', 'y-1')
      await waitFor(() => expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-y', 'y-1'))

      act(() => {
        app!.result.current.openPreviewSection(gfsPreview())
      })
      await act(async () => {
        if (outcome === 'resolve') {
          await clerum.persistLastActive('agent-y', 'y-1')
          opening.resolve()
        } else {
          opening.reject(new Error('y-1 could not be opened'))
        }
      })
      await waitForSettled(app)
    }

    it('shows the chat with its history when the opening succeeds', async () => {
      await openAgentYWhileTabChanges('resolve')

      expect(visibleConversation(app!)).toEqual({
        activeChatId: 'y-1',
        messageIds: [messageIdFor('y-1')],
      })
      expect(errorToasts(app!)).toEqual([])
    })

    it('reports the failed opening exactly once and leaves no spinner', async () => {
      await openAgentYWhileTabChanges('reject')

      expect(errorToasts(app!)).toEqual([
        expect.objectContaining({ text: expect.stringContaining('y-1 could not be opened') }),
      ])
      expect(app!.result.current.chatMessagesLoading).toBe(false)
      expect(app!.result.current.chatListLoading).toBe(false)
    })
  })

  it('opens the latest chat of another agent even when the tab changes while it opens', async () => {
    await seedChats(clerum, 'agent-x', ['x-1'])
    await seedChats(clerum, 'agent-y', ['y-1'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')

    const opening = createDeferred<void>()
    clerum.chat.setLastActive.mockImplementation(async (agent: string, chat: string) => {
      if (agent === 'agent-y') return opening.promise
      return clerum.persistLastActive(agent, chat)
    })
    selectInDrawer(app, 'agent-y', undefined, { selectLatest: true })
    await waitFor(() => expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-y', 'y-1'))

    act(() => {
      app!.result.current.openPreviewSection(gfsPreview())
    })
    await act(async () => {
      await clerum.persistLastActive('agent-y', 'y-1')
      opening.resolve()
    })
    await waitForSettled(app)

    expect(visibleConversation(app)).toEqual({
      activeChatId: 'y-1',
      messageIds: [messageIdFor('y-1')],
    })
  })

  it('still clears the conversation when leaving the chat route for Files', async () => {
    await seedChats(clerum, 'agent-x', ['x-1'])
    app = await bootApp()
    act(() => {
      app!.result.current.handleSelectChatAgent('agent-x', { chatId: 'x-1', selectLatest: false })
    })
    await waitFor(() =>
      expect(visibleConversation(app!)).toEqual({
        activeChatId: 'x-1',
        messageIds: [messageIdFor('x-1')],
      })
    )
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    await waitForSettled(app)

    act(() => {
      app!.result.current.openFilesSection(null)
    })
    await waitForSettled(app)

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(visibleConversation(app)).toEqual({ activeChatId: null, messageIds: [] })
  })

  it('characterizes pre-existing: a same-agent “latest” drawer pick stays unconsumed across non-chat tab changes', async () => {
    await seedChats(clerum, 'agent-x', ['x-1', 'x-2'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')

    // Same agent, no chat id: the drawer blanks and records a `latest` intent
    // that nothing replays until a selection boundary (route into chat, agent
    // or team change).
    selectInDrawer(app, 'agent-x', undefined, { selectLatest: true })
    await waitForSettled(app)
    expect(visibleConversation(app)).toEqual({ activeChatId: null, messageIds: [] })
    const indexCalls = callCount(clerum.chat.getIndex)

    act(() => {
      app!.result.current.openPreviewSection(gfsPreview())
    })
    await waitForSettled(app)
    expect(visibleConversation(app)).toEqual({ activeChatId: null, messageIds: [] })
    expect(callCount(clerum.chat.getIndex)).toBe(indexCalls)

    act(() => {
      app!.result.current.handleSelectChatAgent('agent-x', { chatId: 'x-2', selectLatest: false })
    })
    await waitFor(() =>
      expect(visibleConversation(app!)).toEqual({
        activeChatId: 'x-2',
        messageIds: [messageIdFor('x-2')],
      })
    )
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
  })

  it('makes no chat IPC calls across three non-chat tab changes', async () => {
    await seedChats(clerum, 'agent-x', ['x-1'])
    app = await bootApp()
    await openDrawerOverFiles(app, 'agent-x', 'x-1')
    const before = {
      getIndex: callCount(clerum.chat.getIndex),
      setLastActive: callCount(clerum.chat.setLastActive),
      loadMessages: callCount(clerum.chat.loadMessages),
    }

    act(() => {
      app!.result.current.openPreviewSection(gfsPreview())
    })
    act(() => {
      app!.result.current.handleNavSelect(DESKTOP_ROUTES.settings)
    })
    act(() => {
      app!.result.current.openFilesSection(null)
    })
    await waitForSettled(app)

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect({
      getIndex: callCount(clerum.chat.getIndex),
      setLastActive: callCount(clerum.chat.setLastActive),
      loadMessages: callCount(clerum.chat.loadMessages),
    }).toEqual(before)
    expect(visibleConversation(app)).toEqual({
      activeChatId: 'x-1',
      messageIds: [messageIdFor('x-1')],
    })
  })
})
