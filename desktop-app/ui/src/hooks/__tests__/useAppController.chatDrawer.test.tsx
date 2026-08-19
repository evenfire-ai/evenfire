// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The chat drawer coexists with the live app on the `apps` route. Selecting a
 * chat for the drawer must swap the shared <ChatPage>'s conversation WITHOUT
 * navigating to the full-screen chat route (which would tear down the embed).
 * `keepNavItem` is the single seam that breaks the XOR coupling — these pins
 * fail against the parent commit, where the option does not exist and
 * `handleSelectChatAgent` always flips `navItem` to `chat`.
 */
describe('useAppController — chat drawer keepNavItem', () => {
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

  it('keeps the apps route when selecting a chat with keepNavItem', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Drawer chat',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    // The chat controller now targets the requested agent/chat, but the route
    // stays on `apps` so the live embed survives.
    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('bypasses the same-route fast path with keepNavItem so a concurrent route change survives', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Land on the chat route with the agent selected — this is exactly the state
    // where the fast path (same agent + same-route + chatId) would fire.
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))

    // Launch-from-chat batches a route change to `apps` with a keepNavItem chat
    // selection. `nav.navItem` still reads `chat` when the selection runs, so the
    // fast path would set navItem back to `chat` and leave no pending selection to
    // survive the route change. keepNavItem must force the pending-selection path.
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-2',
        title: 'Seeded from conversation',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('navigates to the full-screen chat route without keepNavItem', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Full screen chat',
        selectLatest: false,
      })
    })

    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
  })
})
