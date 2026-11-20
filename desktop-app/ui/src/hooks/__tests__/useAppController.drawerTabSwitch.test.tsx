// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  bootApp,
  gfsPreview,
  seedChats,
  selectInDrawer,
} from '../domain/__tests__/__fixtures__/drawerSelectionFixtures'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The chat drawer lives over any non-chat tab. Switching the active workspace
 * tab between two non-chat kinds that map to different routes (files →
 * preview) changes `navItem` without the user touching the drawer, so the
 * drawer's persisted conversation must survive that route change.
 */
describe('useAppController — chat drawer across a files → preview tab switch', () => {
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

  it('keeps the drawer chat when the active tab changes from Files to Preview', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await seedChats(clerum, 'agent-x', ['chat-1'])
    const preview = gfsPreview()

    const app = await bootApp()
    unmount = app.unmount

    act(() => {
      app.result.current.openFilesSection(null)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)

    // Drawer selection over the Files tab (the gesture App fires with keepNavItem).
    selectInDrawer(app, 'agent-x', 'chat-1', { title: 'Drawer chat' })
    await waitFor(() => {
      expect(app.result.current.chatMessagesLoading).toBe(false)
      expect(app.result.current.activeChatId).toBe('chat-1')
      expect(app.result.current.activeMessages).toEqual([
        expect.objectContaining({ id: 'chat-1-message' }),
      ])
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)

    act(() => {
      app.result.current.openPreviewSection(preview)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.preview)

    await waitFor(() => {
      expect(app.result.current.chatListLoading).toBe(false)
      expect(app.result.current.chatMessagesLoading).toBe(false)
    })
    expect({
      navItem: app.result.current.navItem,
      activeChatId: app.result.current.activeChatId,
      messages: app.result.current.activeMessages,
    }).toEqual({
      navItem: DESKTOP_ROUTES.preview,
      activeChatId: 'chat-1',
      messages: [expect.objectContaining({ id: 'chat-1-message' })],
    })
  })
})
