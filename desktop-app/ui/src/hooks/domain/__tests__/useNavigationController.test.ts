// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../../constants/navigation'
import {
  clearLatestGfsConversationContext,
  getLatestGfsConversationContext,
} from '../../../lib/gfsConversationPrefill'
import { resolveGfsPreview } from '../../../lib/gfsPreview'
import {
  closeWorkspaceTab,
  openChatTab,
  openFilesTab,
  selectWorkspaceTab,
} from '../../../lib/workspaceTabs'
import { useNavigationController } from '../useNavigationController'

let mainNavigationGeneration = 0
let originalClerum: PropertyDescriptor | undefined

beforeEach(() => {
  mainNavigationGeneration = 0
  originalClerum = Object.getOwnPropertyDescriptor(window, 'clerum')
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        getUserNavigationGeneration: () => mainNavigationGeneration,
        advanceUserNavigationGeneration: () => (mainNavigationGeneration += 1),
      },
    } as unknown as Window['clerum'],
  })
})

afterEach(() => {
  clearLatestGfsConversationContext()
  if (originalClerum) Object.defineProperty(window, 'clerum', originalClerum)
  else Reflect.deleteProperty(window, 'clerum')
  originalClerum = undefined
})

describe('useNavigationController — agent-centric navigation (Fase 2)', () => {
  it('retains the last exact Files context when focusing Chat and clears it at Files root', () => {
    const { result } = renderHook(() => useNavigationController())
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'

    act(() =>
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-context', path: uri, title: 'Reports' })
      )
    )
    expect(getLatestGfsConversationContext()).toEqual({ uri, sourceTabId: 'files-context' })

    act(() => result.current.selectWorkspaceTabById('chat-tab-1'))
    expect(getLatestGfsConversationContext()).toEqual({ uri, sourceTabId: 'files-context' })

    act(() =>
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-root-context', path: null, title: 'Files' })
      )
    )
    expect(getLatestGfsConversationContext()).toBeNull()
  })

  it('clears retained GFS context when the user switches from one chat to another', () => {
    const { result } = renderHook(() => useNavigationController())
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'

    act(() =>
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-context', path: uri })
      )
    )
    act(() => result.current.selectWorkspaceTabById('chat-tab-1'))
    expect(getLatestGfsConversationContext()).toEqual({ uri, sourceTabId: 'files-context' })

    act(() =>
      result.current.setWorkspaceTabs(state =>
        openChatTab(state, { id: 'chat-other', agentRef: 'agent-2', chatId: 'chat-2' })
      )
    )
    expect(getLatestGfsConversationContext()).toBeNull()
  })

  it('clears retained GFS context when the user navigates from Files to Settings', () => {
    const { result } = renderHook(() => useNavigationController())
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'

    act(() =>
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-context', path: uri })
      )
    )
    expect(getLatestGfsConversationContext()).toEqual({ uri, sourceTabId: 'files-context' })

    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.settings))
    expect(result.current.activeTab?.kind).toBe('settings')
    expect(getLatestGfsConversationContext()).toBeNull()
  })

  it('clears retained GFS context when the Apps picker is shown over a Files tab', () => {
    const { result } = renderHook(() => useNavigationController())
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'

    act(() =>
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-context', path: uri })
      )
    )
    expect(getLatestGfsConversationContext()).toEqual({ uri, sourceTabId: 'files-context' })

    act(() => result.current.showAppsPicker())
    expect(getLatestGfsConversationContext()).toBeNull()
  })

  it.each([
    [
      'throws',
      () => {
        throw new Error('generation IPC failed')
      },
    ],
    ['returns malformed data', () => Number.NaN],
  ])('keeps explicit tab navigation usable when generation IPC %s', (_case, advance) => {
    const { result } = renderHook(() => useNavigationController())
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          getUserNavigationGeneration: () => mainNavigationGeneration,
          advanceUserNavigationGeneration: advance,
        },
      },
    })

    expect(() => act(() => result.current.handleNavSelect(DESKTOP_ROUTES.files))).not.toThrow()
    expect(result.current.activeTab?.kind).toBe('files')
    expect(
      result.current.beginGfsResourceNavigation(
        1,
        'gfs://main/0123456789abcdef0123456789abcdef',
        7,
        mainNavigationGeneration
      )
    ).toBeNull()

    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          getUserNavigationGeneration: () => mainNavigationGeneration,
          advanceUserNavigationGeneration: () => (mainNavigationGeneration += 1),
        },
      },
    })
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.chat))
    expect(
      result.current.beginGfsResourceNavigation(
        2,
        'gfs://main/abababababababababababababababab',
        7,
        mainNavigationGeneration
      )
    ).not.toBeNull()
  })

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

  it('carries the listing version into preview state for stale-row ordering', () => {
    const { result } = renderHook(() => useNavigationController())
    const preview = resolveGfsPreview({
      gfsUri: 'gfs://main/versioned',
      name: 'README.md',
      bytes: 80,
      version: 8,
    })
    expect(preview).not.toBeNull()
    act(() => result.current.openPreviewSection(preview!))

    expect(result.current.activeTab?.preview).toMatchObject({
      gfsUri: 'gfs://main/versioned',
      resourceVersion: 8,
    })
  })

  it('restores the owning Files route atomically when a current link opens its Preview tab', () => {
    const { result } = renderHook(() => useNavigationController())
    const filesPath = 'gfs://main/11111111111111111111111111111111'
    const linkedUri = 'gfs://main/22222222222222222222222222222222'
    act(() =>
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-owner', path: filesPath, title: 'Reports' })
      )
    )
    const request = result.current.beginGfsResourceNavigation(1084, linkedUri, 4, 0)
    expect(request).not.toBeNull()
    if (!request) throw new Error('Expected a current resource-link request')
    expect(request.ownerTabId).toBe('files-owner')
    expect(result.current.activateGfsResourceNavigation(request, 4)).toBe(true)

    let completed = false
    act(() => {
      completed = result.current.completeGfsResourceNavigationPreview(
        request,
        {
          gfsUri: linkedUri,
          kind: 'markdown',
          name: 'linked-note.md',
          bytes: 18,
        },
        4,
        { gfsUri: filesPath, name: 'Reports' }
      )
    })

    const owner = result.current.workspaceTabs.tabs.find(tab => tab.id === 'files-owner')
    expect(completed).toBe(true)
    expect(result.current.activeTab?.kind).toBe('preview')
    expect(result.current.activeTab?.preview?.gfsUri).toBe(linkedUri)
    expect(owner?.files?.path).toBe(filesPath)
    expect(owner?.title).toBe('Reports')
  })

  it('fails closed when main cannot provide the link activation generation', () => {
    Reflect.deleteProperty(window, 'clerum')
    const { result } = renderHook(() => useNavigationController())

    expect(
      result.current.beginGfsResourceNavigation(
        1084,
        'gfs://main/22222222222222222222222222222222',
        4,
        0
      )
    ).toBeNull()
  })

  it('rejects a superseded link and gives a newer explicit link its own Files destination', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => {
      result.current.setWorkspaceTabs(state =>
        openFilesTab(state, { id: 'files-root', path: null, title: 'Existing root' })
      )
      result.current.selectWorkspaceTabById('chat-tab-1')
    })

    const stale = result.current.beginGfsResourceNavigation(
      1086,
      'gfs://main/33333333333333333333333333333333',
      4,
      0
    )
    expect(stale).toBeNull()
    expect(result.current.activeTab?.id).toBe('chat-tab-1')

    const current = result.current.beginGfsResourceNavigation(
      1087,
      'gfs://main/44444444444444444444444444444444',
      4,
      1
    )
    expect(current).not.toBeNull()
    if (!current) throw new Error('Expected a link activated after the latest selection')
    expect(current.createDestination).toBe(true)
    expect(current.ownerTabId).not.toBe('files-root')
    let activated = false
    act(() => {
      activated = result.current.activateGfsResourceNavigation(current, 4)
    })
    expect(activated).toBe(true)
    expect(result.current.activeTab?.id).toBe(current.ownerTabId)
    expect(result.current.workspaceTabs.tabs.filter(tab => tab.kind === 'files')).toHaveLength(2)
    expect(
      result.current.workspaceTabs.tabs.find(tab => tab.id === 'files-root')?.files?.path
    ).toBe(null)
  })

  it('never reactivates a link owner after the user selects another tab', () => {
    const { result } = renderHook(() => useNavigationController())
    const uriA = 'gfs://main/11111111111111111111111111111111'
    const uriB = 'gfs://main/22222222222222222222222222222222'
    act(() => {
      result.current.setWorkspaceTabs(state =>
        openFilesTab(openFilesTab(state, { id: 'files-a', path: uriA, title: 'Files A' }), {
          id: 'files-b',
          path: uriB,
          title: 'Files B',
        })
      )
      result.current.selectWorkspaceTabById('files-a')
    })

    const request = result.current.beginGfsResourceNavigation(1085, uriA, 4, 1)
    expect(request).not.toBeNull()
    if (!request) throw new Error('Expected a current resource-link request')
    expect(request.ownerTabId).toBe('files-a')
    expect(result.current.activateGfsResourceNavigation(request, 4)).toBe(true)
    act(() => {
      result.current.selectWorkspaceTabById('files-b')
    })

    let completed = true
    act(() => {
      completed = result.current.completeGfsResourceNavigationPreview(
        request,
        {
          gfsUri: uriA,
          kind: 'markdown',
          name: 'linked-note.md',
          bytes: 18,
        },
        4,
        { gfsUri: uriA, name: 'Files A' }
      )
    })

    expect(completed).toBe(false)
    expect(result.current.activeTab?.id).toBe('files-b')
    expect(result.current.workspaceTabs.tabs.find(tab => tab.id === 'files-a')?.files?.path).toBe(
      uriA
    )
    expect(result.current.workspaceTabs.tabs.find(tab => tab.id === 'files-b')?.files?.path).toBe(
      uriB
    )
    expect(result.current.workspaceTabs.tabs.filter(tab => tab.kind === 'preview')).toHaveLength(0)
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
