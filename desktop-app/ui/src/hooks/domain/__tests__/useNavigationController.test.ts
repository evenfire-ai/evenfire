// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../../constants/navigation'
import {
  closeWorkspaceTab,
  openChatTab,
  openFilesTab,
  selectWorkspaceTab,
} from '../../../lib/workspaceTabs'
import { useNavigationController } from '../useNavigationController'

describe('useNavigationController — agent-centric navigation (Fase 2)', () => {
  it('defaults selectedAgentRoute to Connectors (mcp-servers), not details', () => {
    const { result } = renderHook(() => useNavigationController())
    expect(result.current.selectedAgentRoute).toBe(AGENT_WORKSPACE_ROUTES.connectors)
    expect(result.current.selectedAgentRoute).toBe('mcp-servers')
  })

  it('handleBackToAgents resets the workspace route to Connectors', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.activity))
    act(() => result.current.handleBackToAgents())
    expect(result.current.selectedAgent).toBeNull()
    expect(result.current.selectedAgentRoute).toBe('mcp-servers')
  })

  it('opening chat/agents from the nav resets the route to Connectors', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.members))
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.agents))
    expect(result.current.selectedAgentRoute).toBe('mcp-servers')
  })

  it('tracks the last active chat tab and keeps it across nav to a non-chat tab (§1)', () => {
    const { result } = renderHook(() => useNavigationController())
    // Boot seeds an active blank chat tab -> it is the last active chat tab.
    expect(result.current.lastActiveChatTabId).toBe('chat-tab-1')

    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.files))
    expect(result.current.activeTab?.kind).toBe('files')
    // Navigating to files does NOT forget the chat to return to.
    expect(result.current.lastActiveChatTabId).toBe('chat-tab-1')
  })

  it('updates to the newly active chat and forgets it only when that tab closes (§1)', () => {
    const { result } = renderHook(() => useNavigationController())
    // Go to files first so the persisted chat opens as its OWN tab (no collapse
    // into the boot blank), then activate it.
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.files))
    act(() =>
      result.current.setWorkspaceTabs(state =>
        openChatTab(state, { id: 'persisted', agentRef: 'alpha', chatId: 'c1' })
      )
    )
    expect(result.current.lastActiveChatTabId).toBe('persisted')

    // Back to files: still remembered.
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.files))
    expect(result.current.activeTab?.kind).toBe('files')
    expect(result.current.lastActiveChatTabId).toBe('persisted')

    // Closing the remembered (non-active) chat tab forgets it.
    act(() => result.current.setWorkspaceTabs(state => closeWorkspaceTab(state, 'persisted')))
    expect(result.current.lastActiveChatTabId).toBeNull()
  })

  it('openPreviewSection opens a preview tab and derives the preview route (spec 18)', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() =>
      result.current.openPreviewSection({
        gfsUri: 'gfs://main/image-1',
        kind: 'image',
        mimeType: 'image/png',
        name: 'diagram.png',
        bytes: 3,
      })
    )
    expect(result.current.activeTab?.kind).toBe('preview')
    expect(result.current.activeTab?.title).toBe('diagram.png')
    expect(result.current.activeTab?.preview).toEqual({
      gfsUri: 'gfs://main/image-1',
      fileKind: 'image',
      mimeType: 'image/png',
      byteLength: 3,
    })
    expect(result.current.navItem).toBe(DESKTOP_ROUTES.preview)
  })

  it('openPreviewSection dedupes by gfsUri: re-opening the same file focuses its tab', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() =>
      result.current.openPreviewSection({
        gfsUri: 'gfs://main/image-1',
        kind: 'image',
        mimeType: 'image/png',
        name: 'diagram.png',
        bytes: 3,
      })
    )
    const firstId = result.current.activeTab?.id
    // Navigate away, then re-open the same file: it focuses the existing tab.
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.files))
    act(() =>
      result.current.openPreviewSection({
        gfsUri: 'gfs://main/image-1',
        kind: 'image',
        mimeType: 'image/png',
        name: 'diagram.png',
        bytes: 3,
      })
    )
    expect(result.current.activeTab?.id).toBe(firstId)
    expect(result.current.workspaceTabs.tabs.filter(t => t.kind === 'preview')).toHaveLength(1)
  })

  it('resumes the last active chat, not the last chat by array order, on re-entry (§1, R4-B1)', () => {
    const { result } = renderHook(() => useNavigationController())
    // Build [blank chat, files, A, B] with all real store producers, then leave
    // A as the last active chat while B sits after it in array order.
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.files))
    act(() =>
      result.current.setWorkspaceTabs(state =>
        openChatTab(state, { id: 'chat-a', agentRef: 'alpha', chatId: 'c1' })
      )
    )
    act(() =>
      result.current.setWorkspaceTabs(state =>
        openChatTab(state, { id: 'chat-b', agentRef: 'beta', chatId: 'c2' })
      )
    )
    // Re-activate A so it is the LAST ACTIVE chat while B is the last by order.
    act(() => result.current.setWorkspaceTabs(state => selectWorkspaceTab(state, 'chat-a')))
    expect(result.current.lastActiveChatTabId).toBe('chat-a')

    // Leave the chat section for files (the "return to Chats later" scenario).
    act(() => result.current.setWorkspaceTabs(state => openFilesTab(state, { id: 'files-2' })))
    expect(result.current.activeTab?.kind).toBe('files')
    expect(result.current.lastActiveChatTabId).toBe('chat-a')

    // Re-entering Chats must resume A (the chat the user left), not B (the last
    // chat by array order that the pre-fix precedence would pick).
    let focused: { agentRef: string; chatId: string } | null = null
    act(() => {
      focused = result.current.handleNavSelect(DESKTOP_ROUTES.chat)
    })
    expect(result.current.activeTab?.id).toBe('chat-a')
    expect(focused).toEqual({ agentRef: 'alpha', chatId: 'c1' })
  })

  it('no longer exposes the removed context/teams handlers or state', () => {
    const { result } = renderHook(() => useNavigationController())
    const controller = result.current as Record<string, unknown>
    expect(controller.handleOpenContextDetails).toBeUndefined()
    expect(controller.handleBackToContexts).toBeUndefined()
    expect(controller.handleOpenTeamDetails).toBeUndefined()
    expect(controller.handleBackToTeams).toBeUndefined()
    expect(controller.selectedContext).toBeUndefined()
    expect(controller.selectedContextTab).toBeUndefined()
    expect(controller.selectedTeam).toBeUndefined()
  })
})
