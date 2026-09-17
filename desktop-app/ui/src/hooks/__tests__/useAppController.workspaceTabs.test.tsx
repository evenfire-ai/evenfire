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
})
