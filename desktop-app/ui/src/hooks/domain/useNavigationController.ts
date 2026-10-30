import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../constants/navigation'
import type { GfsPreviewResource } from '../../lib/gfsPreview'
import {
  type GfsResourceNavigationContext,
  type GfsResourceNavigationRequest,
  assignGfsResourceNavigationOwner,
  canCompleteGfsResourceNavigation,
  isGfsResourceNavigationActivationCurrent,
  isGfsResourceNavigationOwnerPresent,
} from '../../lib/gfsResourceNavigationIntent'
import {
  activeWorkspaceTab,
  createFilesTab,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTab,
  setFilesTabPath,
} from '../../lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../lib/workspaceTabs.types'
import { mapKindToRoute, settingsSectionForRoute } from '../../lib/workspaceTabsRoute'
import type { AgentWorkspaceRoute, NavItem } from '../../uiTypes'

export interface WorkspaceNavigationSnapshot {
  workspaceTabs: WorkspaceTabsState
  selectedAgent: string | null
  selectedAgentRoute: AgentWorkspaceRoute
  appsPickerActive: boolean
  lastActiveChatTabId: string | null
}

/**
 * Owner of the universal tab store (mini-spec 03 §3/§4/§6). The store lives here
 * — upstream of `useAgentChatController`, which reads `navItem` in its effect
 * deps — so `navItem` is a SAME-COMMIT derived projection of the active tab
 * (`mapKindToRoute`), never a second writer. Activating a tab flips `navItem` in
 * the same render as the `activeTabId` change, which preserves the
 * `handleSelectChatAgent` fast-path (`nav.navItem === chat`) with no
 * session-blank frame (§4/§9).
 *
 * The instance-less Apps picker (Apps route, no app launched) is the one
 * residual (§ decision B, directive 3): a bounded `navItem === 'sandbox-ui'`
 * flag with NO store tab and NO fabricated placeholder `appRef`. It is
 * single-sourced and cleared the instant any tab is (re)activated, so a derived
 * `navItem` and the residual can never both be live in one commit.
 */
export function useNavigationController() {
  const [workspaceTabs, setWorkspaceTabsState] = useState<WorkspaceTabsState>(() =>
    createWorkspaceTabsState('chat-tab-1')
  )
  const workspaceTabsRef = useRef(workspaceTabs)
  const setWorkspaceTabs = useCallback((action: SetStateAction<WorkspaceTabsState>) => {
    const current = workspaceTabsRef.current
    const next = typeof action === 'function' ? action(current) : action
    if (next === current) return
    workspaceTabsRef.current = next
    setWorkspaceTabsState(next)
  }, [])
  const [navigationIntentSequence, setNavigationIntentSequence] = useState(0)
  const navigationIntentSequenceRef = useRef(0)
  const userNavigationGenerationRef = useRef<number | null>(null)
  const userNavigationGenerationUnavailableRef = useRef(false)
  const currentUserNavigationGeneration = useCallback((): number | null => {
    if (userNavigationGenerationUnavailableRef.current) return null
    if (userNavigationGenerationRef.current !== null) return userNavigationGenerationRef.current
    try {
      const generation =
        typeof window === 'undefined'
          ? undefined
          : window.clerum?.gfs?.getUserNavigationGeneration?.()
      if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) {
        userNavigationGenerationRef.current = generation
      }
    } catch {
      return null
    }
    return userNavigationGenerationRef.current
  }, [])
  const beginNavigationIntent = useCallback(() => {
    const next = navigationIntentSequenceRef.current + 1
    navigationIntentSequenceRef.current = next
    setNavigationIntentSequence(next)
    return next
  }, [])
  const beginUserNavigationIntent = useCallback(() => {
    const advance =
      typeof window === 'undefined'
        ? undefined
        : window.clerum?.gfs?.advanceUserNavigationGeneration
    try {
      if (!advance) throw new Error('The main process GFS navigation generation is unavailable')
      const nextGeneration = advance()
      if (
        typeof nextGeneration !== 'number' ||
        !Number.isSafeInteger(nextGeneration) ||
        nextGeneration < 0
      ) {
        throw new Error('The main process returned an invalid GFS navigation generation')
      }
      userNavigationGenerationRef.current = nextGeneration
      userNavigationGenerationUnavailableRef.current = false
    } catch {
      // Keep local navigation responsive, but do not let an old main value
      // make links eligible after an explicit action we could not order.
      userNavigationGenerationRef.current = null
      userNavigationGenerationUnavailableRef.current = true
    }
    return beginNavigationIntent()
  }, [beginNavigationIntent])
  const isNavigationIntentCurrent = useCallback(
    (sequence: number) => navigationIntentSequenceRef.current === sequence,
    []
  )
  // Residual: the Apps route shown with no launched app (the picker). Launching
  // an app creates a store app tab and clears this.
  const [appsPickerActive, setAppsPickerActive] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<AgentWorkspaceRoute>(
    AGENT_WORKSPACE_ROUTES.connectors
  )

  const tabSequenceRef = useRef(2)
  const nextWorkspaceTabId = useCallback(() => `ws-tab-${tabSequenceRef.current++}`, [])

  const activeTab = useMemo(() => activeWorkspaceTab(workspaceTabs), [workspaceTabs])
  const navItem: NavItem = appsPickerActive ? DESKTOP_ROUTES.apps : mapKindToRoute(activeTab)

  // The last chat tab that was active — the "chat to return to" when the drawer
  // is reopened over a non-chat tab (mini-spec 06 §1). It is NOT cleared by
  // navigating to files/app/settings (that is the whole point: the drawer
  // restores it); it is forgotten only when that tab is closed. Derived from the
  // single store, so every writer (nav, reveal, reconcile) updates it uniformly.
  const [lastActiveChatTabId, setLastActiveChatTabId] = useState<string | null>(null)
  useEffect(() => {
    setLastActiveChatTabId(prev => {
      if (activeTab?.kind === 'chat') return activeTab.id
      if (prev !== null && !workspaceTabs.tabs.some(tab => tab.id === prev)) return null
      return prev
    })
  }, [activeTab, workspaceTabs])
  // Mirror of `lastActiveChatTabId` for the synchronous read in `focusChatSection`
  // (it runs against `workspaceTabsRef.current`, not the render's snapshot).
  const lastActiveChatTabIdRef = useRef(lastActiveChatTabId)
  lastActiveChatTabIdRef.current = lastActiveChatTabId

  const clearAppsPicker = useCallback(() => setAppsPickerActive(false), [])

  // Session identity owns the workspace contents. Tear navigation down before a
  // different principal is published, and give the new session one fresh blank
  // Chat tab. Advancing the local intent sequence fences pending continuations;
  // this is not a user selection and does not advance the main-process link
  // generation.
  const resetSessionNavigation = useCallback(() => {
    beginNavigationIntent()
    setSelectedAgent(null)
    setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
    setAppsPickerActive(false)
    const chatTabId = nextWorkspaceTabId()
    setWorkspaceTabs(createWorkspaceTabsState(chatTabId))
    lastActiveChatTabIdRef.current = chatTabId
    setLastActiveChatTabId(chatTabId)
  }, [beginNavigationIntent, nextWorkspaceTabId, setWorkspaceTabs])

  const captureWorkspaceNavigation = useCallback(
    (): WorkspaceNavigationSnapshot => ({
      workspaceTabs: workspaceTabsRef.current,
      selectedAgent,
      selectedAgentRoute,
      appsPickerActive,
      lastActiveChatTabId: lastActiveChatTabIdRef.current,
    }),
    [appsPickerActive, selectedAgent, selectedAgentRoute]
  )

  const restoreWorkspaceNavigation = useCallback(
    (snapshot: WorkspaceNavigationSnapshot, expectedIntentSequence: number): number | null => {
      if (!isNavigationIntentCurrent(expectedIntentSequence)) return null
      const restoredIntentSequence = beginNavigationIntent()
      setWorkspaceTabs(snapshot.workspaceTabs)
      setSelectedAgent(snapshot.selectedAgent)
      setSelectedAgentRoute(snapshot.selectedAgentRoute)
      setAppsPickerActive(snapshot.appsPickerActive)
      lastActiveChatTabIdRef.current = snapshot.lastActiveChatTabId
      setLastActiveChatTabId(snapshot.lastActiveChatTabId)
      return restoredIntentSequence
    },
    [beginNavigationIntent, isNavigationIntentCurrent, setWorkspaceTabs]
  )

  // Apps route with no launched app → the picker residual. Redundant (and thus
  // skipped) when an app tab is already active, since that already derives to
  // the Apps route.
  const showAppsPicker = useCallback(() => {
    beginUserNavigationIntent()
    setAppsPickerActive(activeWorkspaceTab(workspaceTabsRef.current)?.kind !== 'app')
  }, [beginUserNavigationIntent])

  // Ensure a chat tab is active (navItem → chat this commit) without agent
  // logic: keep the active chat tab, else focus the last chat tab, else seed a
  // blank one. Agent selection is layered on by `handleSelectChatAgent`.
  //
  // This precedence is the SINGLE source of "which chat did the nav focus":
  // it RETURNS the focused conversation's identity (`agentRef`/`chatId`) when a
  // real chat is focused, or `null` when it keeps/seeds a blank chat. The caller
  // (`useAppController.handleNavSelect`) loads exactly that value instead of
  // re-deriving the same rule in its own layer, so the loaded chat can never
  // drift from the focused one (D4).
  const focusChatSection = useCallback(
    (
      source: 'explicit' | 'programmatic' = 'explicit'
    ): { agentRef: string; chatId: string } | null => {
      if (source === 'explicit') {
        beginUserNavigationIntent()
      } else if (navigationIntentSequenceRef.current > 0) {
        // A session/bootstrap continuation may select the default Chat route
        // only while no explicit navigation has happened in this renderer.
        // In particular, it must not replace a tab selected while auth loads.
        return null
      }
      setAppsPickerActive(false)
      const current = workspaceTabsRef.current
      const active = activeWorkspaceTab(current)
      // Precedence (mini-spec 08 §1): the active chat wins (no re-homing); else
      // RESUME the last active chat tab the user left — validated live against the
      // store so a not-yet-reflected close cannot resurrect a stale id — rather than
      // the last chat by array order; else the last chat by order (first boot, no
      // last-active); else seed a blank.
      const lastActiveId = lastActiveChatTabIdRef.current
      const resumeTarget =
        lastActiveId !== null
          ? current.tabs.find(tab => tab.id === lastActiveId && tab.kind === 'chat')
          : undefined
      const target =
        active?.kind === 'chat'
          ? active
          : (resumeTarget ?? [...current.tabs].reverse().find(tab => tab.kind === 'chat'))
      if (target) {
        setWorkspaceTabs(state =>
          state.activeTabId === target.id ? state : { ...state, activeTabId: target.id }
        )
        return target.chat?.agentRef && target.chat.chatId
          ? { agentRef: target.chat.agentRef, chatId: target.chat.chatId }
          : null
      }
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(state => newChatTab(state, id, null))
      return null
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  /**
   * Activate a chat tab so `navItem` derives to `chat` in the same commit as the
   * selection (the replacement for the old `nav.setNavItem(chat)`). Persisted
   * chats dedupe/focus by `chatId`; a blank selection reuses the active blank
   * chat or appends one. Used by `handleSelectChatAgent` on its non-`keepNavItem`
   * paths; the `keepNavItem` (drawer) paths never call it, so the app tab stays
   * active and the route stays on `apps`.
   */
  const activateChatTab = useCallback(
    (
      agentRef: string | null,
      chatId: string | null,
      title?: string,
      navigationIntentAlreadyStarted = false
    ) => {
      if (!navigationIntentAlreadyStarted) beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current =>
        chatId
          ? openChatTab(current, {
              id,
              agentRef,
              chatId,
              ...(title ? { title } : {}),
            })
          : newChatTab(current, id, agentRef)
      )
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  const openSettingsSection = useCallback(
    (
      section: Parameters<typeof openSettingsTab>[1]['section'],
      navigationIntentAlreadyStarted = false
    ) => {
      if (!navigationIntentAlreadyStarted) beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current => openSettingsTab(current, { id, section }))
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  // Open/focus a files tab at `path` (a gfsUri, or `null` for the virtual root).
  // Dedupes by path in the store: the sidebar "Files" entry (root) and a plugin
  // deep-link to a specific gfsUri both route here (mini-spec 06 §3).
  const openFilesSection = useCallback(
    (path: string | null = null) => {
      beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current => openFilesTab(current, { id, path }))
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  // Open/focus a preview tab for a previewable file (spec 18 §3.B.1). Dedupes by
  // gfsUri in the store: opening the same file twice focuses its existing tab
  // instead of stacking duplicates. A direct clone of `openFilesSection`.
  const openPreviewSection = useCallback(
    (preview: GfsPreviewResource) => {
      beginUserNavigationIntent()
      setAppsPickerActive(false)
      const id = nextWorkspaceTabId()
      setWorkspaceTabs(current =>
        openPreviewTab(current, {
          id,
          title: preview.name,
          gfsUri: preview.gfsUri,
          fileKind: preview.kind,
          byteLength: preview.bytes,
          ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
          ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
        })
      )
    },
    [beginUserNavigationIntent, nextWorkspaceTabId]
  )

  const beginGfsResourceNavigation = useCallback(
    (
      id: number,
      uri: string,
      principalGeneration: number,
      userNavigationGenerationAtActivation: number
    ): GfsResourceNavigationRequest | null => {
      const currentGeneration = currentUserNavigationGeneration()
      if (
        currentGeneration === null ||
        !isGfsResourceNavigationActivationCurrent(
          userNavigationGenerationAtActivation,
          currentGeneration
        )
      ) {
        return null
      }
      const intentSequence = beginNavigationIntent()
      const state = workspaceTabsRef.current
      const owner = assignGfsResourceNavigationOwner(state, uri)
      return {
        id,
        uri,
        ownerTabId: owner.createDestination ? nextWorkspaceTabId() : owner.ownerTabId,
        createDestination: owner.createDestination,
        intentSequence,
        principalGeneration,
        userNavigationGenerationAtActivation,
      }
    },
    [beginNavigationIntent, currentUserNavigationGeneration, nextWorkspaceTabId]
  )

  const isGfsResourceNavigationCurrent = useCallback(
    (request: GfsResourceNavigationRequest, principalGeneration: number): boolean => {
      const userNavigationGeneration = currentUserNavigationGeneration()
      if (userNavigationGeneration === null) return false
      const state = workspaceTabsRef.current
      const context: GfsResourceNavigationContext = {
        intentSequence: navigationIntentSequenceRef.current,
        principalGeneration,
        userNavigationGeneration,
        activeTabId: state.activeTabId,
        tabs: state.tabs,
      }
      return canCompleteGfsResourceNavigation(request, context)
    },
    [currentUserNavigationGeneration]
  )

  const activateGfsResourceNavigation = useCallback(
    (request: GfsResourceNavigationRequest, principalGeneration: number): boolean => {
      if (
        !isNavigationIntentCurrent(request.intentSequence) ||
        request.principalGeneration !== principalGeneration ||
        currentUserNavigationGeneration() !== request.userNavigationGenerationAtActivation
      ) {
        return false
      }
      const state = workspaceTabsRef.current
      let next: WorkspaceTabsState
      if (request.createDestination) {
        if (state.tabs.some(tab => tab.id === request.ownerTabId)) return false
        next = createFilesTab(state, { id: request.ownerTabId, path: null })
      } else {
        if (!isGfsResourceNavigationOwnerPresent(request, state.tabs)) return false
        next = selectWorkspaceTab(state, request.ownerTabId)
      }
      if (next.activeTabId !== request.ownerTabId) return false
      setAppsPickerActive(false)
      setWorkspaceTabs(next)
      return true
    },
    [currentUserNavigationGeneration, isNavigationIntentCurrent, setWorkspaceTabs]
  )

  const completeGfsResourceNavigationPreview = useCallback(
    (
      request: GfsResourceNavigationRequest,
      preview: GfsPreviewResource,
      principalGeneration: number,
      returnLocation: { gfsUri: string | null; name: string | null }
    ): boolean => {
      if (!isGfsResourceNavigationCurrent(request, principalGeneration)) return false
      const id = nextWorkspaceTabId()
      const ownerWithRestoredLocation = setFilesTabPath(
        workspaceTabsRef.current,
        request.ownerTabId,
        returnLocation.gfsUri,
        returnLocation.name ?? undefined
      )
      const next = openPreviewTab(ownerWithRestoredLocation, {
        id,
        title: preview.name,
        gfsUri: preview.gfsUri,
        fileKind: preview.kind,
        byteLength: preview.bytes,
        ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
        ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
      })
      setAppsPickerActive(false)
      setWorkspaceTabs(next)
      return next.activeTabId !== request.ownerTabId
    },
    [isGfsResourceNavigationCurrent, nextWorkspaceTabId, setWorkspaceTabs]
  )

  const selectWorkspaceTabById = useCallback(
    (id: string): boolean => {
      const tab = workspaceTabsRef.current.tabs.find(candidate => candidate.id === id)
      if (!tab) return false
      beginUserNavigationIntent()
      setAppsPickerActive(false)
      setWorkspaceTabs(state => selectWorkspaceTab(state, id))
      return true
    },
    [beginUserNavigationIntent, setWorkspaceTabs]
  )

  // Base section navigation: every legacy `handleNavSelect(route)` call-site
  // routes here and becomes an open/focus tab action (the single writer). For
  // `chat`/`agents` it also clears `selectedAgent` exactly as before.
  // Returns the chat `focusChatSection` focused (for the chat route) so the
  // coordinator can load exactly that conversation; `null` for every other route
  // and for a blank/seeded chat.
  const handleNavSelect = useCallback(
    (
      item: NavItem,
      options: {
        source?: 'explicit' | 'programmatic'
        navigationIntentAlreadyStarted?: boolean
      } = {}
    ): { agentRef: string; chatId: string } | null => {
      const source = options.source ?? 'explicit'
      if (source === 'programmatic' && navigationIntentSequenceRef.current > 0) return null
      if (item === DESKTOP_ROUTES.chat) {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
        return focusChatSection(source)
      }
      if (item === DESKTOP_ROUTES.apps) {
        showAppsPicker()
        return null
      }
      if (item === DESKTOP_ROUTES.files) {
        openFilesSection()
        return null
      }
      const section = settingsSectionForRoute(item)
      if (!section) return null
      if (section === 'agents') {
        setSelectedAgent(null)
        setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
      }
      openSettingsSection(section, options.navigationIntentAlreadyStarted)
      return null
    },
    [focusChatSection, openFilesSection, openSettingsSection, showAppsPicker]
  )

  const handleBackToAgents = useCallback(() => {
    setSelectedAgent(null)
    setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
  }, [])

  return {
    // Derived route (single-writer projection of the active tab).
    navItem,
    // Universal tab store.
    workspaceTabs,
    setWorkspaceTabs,
    navigationIntentSequence,
    beginUserNavigationIntent,
    isNavigationIntentCurrent,
    beginGfsResourceNavigation,
    isGfsResourceNavigationCurrent,
    activateGfsResourceNavigation,
    completeGfsResourceNavigationPreview,
    selectWorkspaceTabById,
    activeTab,
    nextWorkspaceTabId,
    appsPickerActive,
    showAppsPicker,
    clearAppsPicker,
    resetSessionNavigation,
    captureWorkspaceNavigation,
    restoreWorkspaceNavigation,
    activateChatTab,
    lastActiveChatTabId,
    openFilesSection,
    openPreviewSection,
    // Agent/chat selection state (stays here through this slice; §4).
    selectedAgent,
    selectedAgentRoute,
    setSelectedAgent,
    setSelectedAgentRoute,
    handleNavSelect,
    handleBackToAgents,
  }
}
