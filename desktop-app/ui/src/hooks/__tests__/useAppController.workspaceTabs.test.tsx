// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Ported-behavior regression pins for the universal-tab-store integration
 * (mini-spec 03 §2/§4). Both assert the store observable that the port now
 * carries — the active tab and its agent/chat identity — so they exercise the
 * seam, not just the pre-existing selectedAgent field.
 */
describe('useAppController — universal tab store ports', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  // (a) Going to chat auto-selects the last agent, and the active workspace tab
  // becomes that agent's chat tab (navItem derives to chat in the same commit).
  it('auto-selects the last agent and activates its chat tab when navigating to chat', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Leave the chat route so navigating back must auto-select.
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.connectors)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.connectors)
    expect(app.result.current.selectedAgent).toBe(null)

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.chat)
    })

    // Ported behavior: the last agent is auto-selected...
    expect(app.result.current.selectedAgent).toBe('agent-x')
    // ...and the derived route + the active tab reflect it in the same commit.
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    const active = activeWorkspaceTab(app.result.current.workspaceTabs)
    expect(active?.kind).toBe('chat')
    expect(active?.chat?.agentRef).toBe('agent-x')
  })

  // (a2) Navigating back to chat RESUMES the existing conversation instead of
  // appending a fresh blank chat on every click. Regression for the "each click
  // on the chats nav opens a NEW chat" bug: the parent unconditionally ran
  // `handleSelectChatAgent(latestAgent, { selectLatest: false })`, which appended
  // a blank chat tab whenever the focused chat was a real conversation.
  it('resumes the existing conversation (no new chat tab) when navigating back to chat', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Open a real conversation, then leave the chat route for a DOM tab.
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    const chatTabsBefore = app.result.current.workspaceTabs.tabs.filter(
      tab => tab.kind === 'chat'
    ).length

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.files)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)

    // Click "chats": must re-activate chat-1, not spawn a new blank chat.
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.chat)
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(app.result.current.activeChatId).toBe('chat-1')
    const active = activeWorkspaceTab(app.result.current.workspaceTabs)
    expect(active?.kind).toBe('chat')
    expect(active?.chat?.chatId).toBe('chat-1')
    // No extra chat tab was appended.
    const chatTabsAfter = app.result.current.workspaceTabs.tabs.filter(
      tab => tab.kind === 'chat'
    ).length
    expect(chatTabsAfter).toBe(chatTabsBefore)
  })

  // (b) A pending chat selection survives a tab/route change: selecting a chat
  // with keepNavItem while on the apps route records the pending selection, and
  // the agent-selection effect replays it (the chat actually loads) without
  // flipping the active tab away from apps.
  it('preserves the pending chat selection across a tab change (keepNavItem)', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Move onto the apps route (its store tab is active; navItem derives to apps).
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)

    // Select a chat in the drawer (keepNavItem): the active tab must NOT change
    // to a chat tab, but the pending selection must survive and load the chat.
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Kept chat',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(app.result.current.selectedAgent).toBe('agent-x')
    // The pending selection replayed and the chat loaded — the observable, not a
    // spinner stuck forever.
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    expect(app.result.current.activeChatId).toBe('chat-1')
  })

  // (c) openPreviewSection is re-exported through the controller (spec 18): it
  // opens a preview tab and the derived navItem flips to the preview route in the
  // same commit — the seam the App render uses to mount FilePreviewPage.
  it('opens a preview tab and derives the preview route via openPreviewSection', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.openPreviewSection({
        gfsUri: 'gfs://main/image-1',
        kind: 'image',
        mimeType: 'image/png',
        name: 'diagram.png',
        bytes: 3,
      })
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.preview)
    const active = activeWorkspaceTab(app.result.current.workspaceTabs)
    expect(active?.kind).toBe('preview')
    expect(active?.title).toBe('diagram.png')
    expect(active?.preview?.gfsUri).toBe('gfs://main/image-1')
  })
})
